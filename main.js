const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  nativeTheme,
  net,
  screen,
  session,
} = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ---------- Config persistence ----------
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    // Strip a leading BOM if present so JSON.parse doesn't choke.
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, '');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save config:', e);
  }
}

let config = loadConfig();

const WIN_WIDTH = 260;
const WIN_HEIGHT = 74;
const POPOVER_WIDTH = 260;
const POPOVER_HEIGHT = 84;
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');

// ---------- Display mode ----------
// taskbar  -> Windows 11 (embed widget into the taskbar)
// menubar  -> macOS (title in the menu bar + hover popover)
// floating -> Windows 10 and below, Linux (original desktop card)
function detectMode() {
  if (process.platform === 'darwin') return 'menubar';
  if (process.platform === 'win32') {
    const build = parseInt(os.release().split('.')[2], 10);
    if (Number.isFinite(build) && build >= 22000) return 'taskbar';
  }
  return 'floating';
}

let mode = detectMode();

// taskbar-win.js pulls in a native FFI dependency, so only load it on Windows.
const taskbarWin = mode === 'taskbar' ? require('./taskbar-win') : null;

// ---------- i18n ----------
// Detect the OS UI language. Chinese locales use Chinese; everything else
// falls back to English.
const STRINGS = {
  zh: {
    apiLang: 'zh-CN',
    trayShow: '显示面板',
    trayRefresh: '立即刷新',
    trayQuit: '退出',
    trayFieldIp: '菜单栏显示 IP',
    trayFieldLoc: '菜单栏显示位置',
    trayFieldIsp: '菜单栏显示运营商',
    tooltip: 'IPWindow',
    ipLoading: '获取中…',
    labelLoc: '位置',
    closeTitle: '退出',
    unknownLoc: '未知位置',
    updatePrefix: '更新 ',
    queryFailed: '查询失败',
    networkError: '网络错误',
  },
  en: {
    apiLang: 'en',
    trayShow: 'Show Panel',
    trayRefresh: 'Refresh Now',
    trayQuit: 'Quit',
    trayFieldIp: 'Menu bar: IP',
    trayFieldLoc: 'Menu bar: Location',
    trayFieldIsp: 'Menu bar: ISP',
    tooltip: 'IPWindow',
    ipLoading: 'Loading…',
    labelLoc: 'Location',
    closeTitle: 'Quit',
    unknownLoc: 'Unknown location',
    updatePrefix: 'Updated ',
    queryFailed: 'Lookup failed',
    networkError: 'Network error',
  },
};

let t = STRINGS.en; // resolved in app.whenReady once the locale is available.

let win = null; // primary window: floating card or embedded taskbar widget
let popover = null; // hover detail popover (taskbar + menubar modes)
let tray = null;
let refreshTimer = null;
let popoverHideTimer = null;
let lastInfo = null; // most recent successful lookup

// ---------- IP lookup ----------
// ip-api.com (free, no key). Returns the public IP of the requester + geo info.
// Chinese localization via lang=zh-CN.
function fetchIpInfo() {
  return new Promise((resolve, reject) => {
    const url =
      'http://ip-api.com/json/?fields=status,message,country,regionName,city,query,isp&lang=' +
      t.apiLang;
    // Electron's net module goes through Chromium's network stack, so it
    // honors the system proxy settings — the lookup reflects the proxy exit IP.
    const req = net.request({ url, useSessionCookies: false });
    let data = '';
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    };

    const timer = setTimeout(() => {
      try {
        req.abort();
      } catch {}
      fail(new Error('timeout'));
    }, 10000);

    req.on('response', (res) => {
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        try {
          const json = JSON.parse(data);
          if (json.status === 'success') {
            resolve({
              ip: json.query,
              location: [json.country, json.regionName, json.city]
                .filter(Boolean)
                .join(' '),
              isp: json.isp || '',
            });
          } else {
            reject(new Error(json.message || 'lookup failed'));
          }
        } catch (e) {
          reject(e);
        }
      });
      res.on('error', (e) => {
        clearTimeout(timer);
        fail(e);
      });
    });
    req.on('error', (e) => {
      clearTimeout(timer);
      fail(e);
    });
    req.end();
  });
}

// Send a message to every live renderer (primary window + popover).
function broadcast(channel, payload) {
  for (const w of [win, popover]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

async function refreshAndSend() {
  broadcast('ip:loading');
  try {
    const info = await fetchIpInfo();
    lastInfo = { ...info, time: Date.now() };
    broadcast('ip:update', lastInfo);
    updateTrayTitle();
  } catch (e) {
    broadcast('ip:error', { message: e.message, time: Date.now() });
  }
}

function sendI18n(target) {
  if (!target || target.isDestroyed()) return;
  target.webContents.send('i18n', {
    ipLoading: t.ipLoading,
    labelLoc: t.labelLoc,
    closeTitle: t.closeTitle,
    unknownLoc: t.unknownLoc,
    updatePrefix: t.updatePrefix,
    queryFailed: t.queryFailed,
    networkError: t.networkError,
  });
}

function currentTheme() {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

// ---------- Windows ----------
function createFloatingWindow() {
  const saved = config.bounds || {};
  win = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    x: typeof saved.x === 'number' ? saved.x : undefined,
    y: typeof saved.y === 'number' ? saved.y : undefined,
    icon: ICON_PATH,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile('index.html');

  // Persist position after the user drags the window.
  let saveDebounce = null;
  const persistBounds = () => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    config.bounds = { x: b.x, y: b.y };
    if (saveDebounce) clearTimeout(saveDebounce);
    saveDebounce = setTimeout(() => saveConfig(config), 300);
  };
  win.on('moved', persistBounds);

  win.webContents.on('did-finish-load', () => {
    sendI18n(win);
    refreshAndSend();
  });
}

function createTaskbarWindow() {
  win = new BrowserWindow({
    width: taskbarWin.WIDGET_WIDTH,
    height: 48,
    icon: ICON_PATH,
    frame: false,
    transparent: false,
    backgroundColor: '#1f2023',
    resizable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Keep the embedded widget repainting even though Chromium may consider
      // a reparented window occluded.
      backgroundThrottling: false,
    },
  });

  win.loadFile('taskbar.html');

  win.webContents.on('did-finish-load', () => {
    sendI18n(win);
    win.webContents.send('theme', currentTheme());
    // Show it (so Chromium starts painting) before reparenting it into the
    // taskbar — embed() repositions it immediately, so any flash is momentary.
    win.showInactive();
    // Reparent the window into the taskbar. If it fails for any reason, fall
    // back to the regular floating card so the app stays usable.
    if (!taskbarWin.embed(win)) {
      console.error('[main] taskbar embed failed, falling back to floating');
      mode = 'floating';
      destroyPopover();
      win.destroy();
      win = null;
      createFloatingWindow();
      return;
    }
    refreshAndSend();
  });
}

function createPopover() {
  popover = new BrowserWindow({
    width: POPOVER_WIDTH,
    height: POPOVER_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    show: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  popover.setAlwaysOnTop(true, 'screen-saver');
  popover.loadFile('popover.html');
  popover.webContents.on('did-finish-load', () => {
    sendI18n(popover);
    // menubar mode has no primary window, so the popover kicks off the first
    // lookup once it has loaded.
    if (mode === 'menubar') refreshAndSend();
  });
}

function destroyPopover() {
  if (popover && !popover.isDestroyed()) popover.destroy();
  popover = null;
}

// ---------- Hover popover ----------
function positionPopover() {
  if (!popover || popover.isDestroyed()) return;
  const pb = popover.getBounds();
  if (mode === 'taskbar') {
    const r = taskbarWin.getWidgetScreenRect();
    if (!r) return;
    // Win32 returns physical pixels; Electron bounds are in DIPs.
    const dip = screen.screenToDipPoint({ x: r.x, y: r.y });
    popover.setBounds({
      x: Math.round(dip.x),
      y: Math.round(dip.y) - pb.height - 6,
      width: pb.width,
      height: pb.height,
    });
  } else if (mode === 'menubar' && tray) {
    const b = tray.getBounds();
    popover.setBounds({
      x: Math.round(b.x + b.width / 2 - pb.width / 2),
      y: Math.round(b.y + b.height + 4),
      width: pb.width,
      height: pb.height,
    });
  }
}

function showPopover() {
  if (!popover || popover.isDestroyed()) return;
  if (popoverHideTimer) {
    clearTimeout(popoverHideTimer);
    popoverHideTimer = null;
  }
  positionPopover();
  if (lastInfo) popover.webContents.send('ip:update', lastInfo);
  popover.showInactive();
}

function hidePopover() {
  if (popoverHideTimer) clearTimeout(popoverHideTimer);
  // Small delay so moving the cursor between the widget and the popover (or
  // within either) doesn't make it flicker.
  popoverHideTimer = setTimeout(() => {
    if (popover && !popover.isDestroyed()) popover.hide();
  }, 220);
}

// ---------- Tray ----------
function updateTrayTitle() {
  if (mode !== 'menubar' || !tray) return;
  const field = config.menubarField || 'loc';
  let text = t.ipLoading;
  if (lastInfo) {
    text =
      field === 'ip'
        ? lastInfo.ip
        : field === 'isp'
        ? lastInfo.isp || lastInfo.location
        : lastInfo.location;
  }
  tray.setTitle(' ' + (text || ''));
}

function buildTrayMenu(showWindow) {
  const items = [];
  if (mode === 'floating') items.push({ label: t.trayShow, click: showWindow });
  items.push({ label: t.trayRefresh, click: () => refreshAndSend() });
  if (mode === 'menubar') {
    const field = config.menubarField || 'loc';
    const setField = (f) => {
      config.menubarField = f;
      saveConfig(config);
      updateTrayTitle();
      tray.setContextMenu(buildTrayMenu(showWindow));
    };
    items.push({ type: 'separator' });
    items.push({
      label: t.trayFieldLoc,
      type: 'radio',
      checked: field === 'loc',
      click: () => setField('loc'),
    });
    items.push({
      label: t.trayFieldIp,
      type: 'radio',
      checked: field === 'ip',
      click: () => setField('ip'),
    });
    items.push({
      label: t.trayFieldIsp,
      type: 'radio',
      checked: field === 'isp',
      click: () => setField('isp'),
    });
  }
  items.push({ type: 'separator' });
  items.push({ label: t.trayQuit, click: () => app.quit() });
  return Menu.buildFromTemplate(items);
}

function createTray() {
  let icon = nativeImage.createFromPath(ICON_PATH);
  if (!icon.isEmpty()) {
    // Tray icons are tiny; scale the master image down so it renders crisply.
    icon = icon.resize({ width: 32, height: 32 });
    if (mode === 'menubar') icon.setTemplateImage(true);
  }
  try {
    tray = new Tray(icon);
  } catch {
    return;
  }
  const showWindow = () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.setAlwaysOnTop(true, 'screen-saver');
  };

  if (mode === 'menubar') {
    updateTrayTitle();
    // macOS-only tray hover events drive the detail popover.
    tray.on('mouse-enter', showPopover);
    tray.on('mouse-leave', hidePopover);
  } else {
    // Double-clicking the tray icon also brings the widget back.
    tray.on('double-click', showWindow);
  }
  tray.setToolTip(t.tooltip);
  tray.setContextMenu(buildTrayMenu(showWindow));
}

// ---------- IPC ----------
ipcMain.on('ip:refresh', () => refreshAndSend());
ipcMain.on('app:quit', () => app.quit());
ipcMain.on('popover:enter', showPopover);
ipcMain.on('popover:leave', hidePopover);

app.whenReady().then(() => {
  // Resolve UI language from the OS locale (Chinese → zh, otherwise English).
  t = app.getLocale().toLowerCase().startsWith('zh') ? STRINGS.zh : STRINGS.en;

  // Follow the OS proxy configuration so the IP lookup reflects the proxy.
  session.defaultSession.setProxy({ mode: 'system' }).catch(() => {});

  if (mode === 'taskbar') {
    createTaskbarWindow();
    createPopover();
  } else if (mode === 'menubar') {
    createPopover();
  } else {
    createFloatingWindow();
  }
  createTray();

  // Keep the embedded taskbar widget legible when the OS theme flips.
  nativeTheme.on('updated', () => {
    if (mode === 'taskbar' && win && !win.isDestroyed()) {
      win.webContents.send('theme', currentTheme());
    }
  });

  // Refresh every 5 minutes.
  refreshTimer = setInterval(refreshAndSend, 5 * 60 * 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (mode === 'taskbar') createTaskbarWindow();
      else if (mode === 'floating') createFloatingWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (refreshTimer) clearInterval(refreshTimer);
  if (mode === 'taskbar' && taskbarWin) taskbarWin.release();
});
