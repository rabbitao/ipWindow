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
// Taskbar overlay widget footprint and spacing (DIP).
const TASKBAR_WIDGET_WIDTH = 210;
const TASKBAR_LEFT_MARGIN = 6; // gap from the taskbar's left edge when no weather button
const TASKBAR_GAP = 8; // gap from the weather button / system tray
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

let win = null; // primary window: floating card or taskbar overlay widget
let popover = null; // hover detail popover (taskbar + menubar modes)
let tray = null;
let refreshTimer = null;
let popoverHideTimer = null;
let lastInfo = null; // most recent successful lookup

// ---------- Taskbar overlay state (Windows 11) ----------
let taskbarHwnd = null; // BigInt HWND of our overlay window
let taskbarTimer = null; // periodic reposition / z-order assert
let taskbarTick = 0;
let dragTimer = null; // active while the user drags the widget
let draggingTaskbar = false;
let dragGrabDX = 0; // cursor-x minus window-x at drag start

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
    width: TASKBAR_WIDGET_WIDTH,
    height: 48,
    icon: ICON_PATH,
    frame: false,
    transparent: true, // -> WS_EX_LAYERED, blends into the taskbar
    backgroundColor: '#00000000',
    resizable: false,
    focusable: false, // -> WS_EX_NOACTIVATE, clicking it never steals focus
    skipTaskbar: true, // -> tool window, no taskbar button / Alt-Tab entry
    alwaysOnTop: true,
    show: false,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The window may be considered occluded by the taskbar; keep painting.
      backgroundThrottling: false,
    },
  });

  // 'screen-saver' is a z-band above the (topmost) taskbar.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile('taskbar.html');

  win.webContents.on('did-finish-load', () => {
    sendI18n(win);
    win.webContents.send('theme', currentTheme());
    const hb = win.getNativeWindowHandle();
    taskbarHwnd = hb.length >= 8 ? hb.readBigUInt64LE(0) : BigInt(hb.readUInt32LE(0));
    // Place it over the taskbar before showing. If the taskbar can't be found,
    // fall back to the regular floating card so the app stays usable.
    if (!positionTaskbarWidget()) {
      console.error('[main] taskbar not found, falling back to floating');
      mode = 'floating';
      destroyPopover();
      win.destroy();
      win = null;
      createFloatingWindow();
      return;
    }
    win.showInactive();
    taskbarWin.refreshWidgetsButton();
    // Re-assert placement + z-order every second to follow taskbar resize / DPI
    // / theme / explorer restarts.
    taskbarTimer = setInterval(onTaskbarTick, 1000);
    refreshAndSend();
  });
}

function taskbarSide() {
  return config.taskbarSide === 'right' ? 'right' : 'left';
}

// Win32 RECT (in physical px) -> {x,y,width,height}.
function rectXYWH(r) {
  return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
}

// Compute the widget's bounds (DIP) for the configured side, anchored to the
// right of the weather button (left side) or the left of the system tray
// (right side). Returns null if the taskbar can't be located.
function computeTaskbarBounds() {
  const layout = taskbarWin.getLayout();
  if (!layout) return null;
  const tb = screen.screenToDipRect(null, rectXYWH(layout.taskbarRect));
  const W = TASKBAR_WIDGET_WIDTH;
  let x;
  if (taskbarSide() === 'right' && layout.trayRect) {
    const tray = screen.screenToDipRect(null, rectXYWH(layout.trayRect));
    x = tray.x - W - TASKBAR_GAP;
  } else if (layout.widgetsRight != null) {
    x = screen.screenToDipPoint({ x: layout.widgetsRight, y: layout.taskbarRect.top }).x + TASKBAR_GAP;
  } else {
    x = tb.x + TASKBAR_LEFT_MARGIN;
  }
  // Keep it within the taskbar horizontally.
  x = Math.max(tb.x, Math.min(x, tb.x + tb.width - W));
  return { x: Math.round(x), y: Math.round(tb.y), width: W, height: Math.round(tb.height) };
}

function positionTaskbarWidget() {
  if (!win || win.isDestroyed()) return false;
  const b = computeTaskbarBounds();
  if (!b) return false;
  win.setBounds(b);
  return true;
}

function onTaskbarTick() {
  if (!win || win.isDestroyed() || draggingTaskbar) return;
  positionTaskbarWidget();
  if (taskbarHwnd) taskbarWin.assertTopmost(taskbarHwnd);
  // Re-check the weather button every ~10s (it appears/disappears or changes
  // width when Widgets is toggled or the forecast text changes).
  if (++taskbarTick % 10 === 0) taskbarWin.refreshWidgetsButton();
}

// ---------- Drag to reposition (snaps to the nearer side) ----------
function startTaskbarDrag() {
  if (mode !== 'taskbar' || !win || win.isDestroyed() || draggingTaskbar) return;
  const cur = screen.getCursorScreenPoint();
  dragGrabDX = cur.x - win.getBounds().x;
  draggingTaskbar = true;
  if (popover && !popover.isDestroyed()) popover.hide();
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = setInterval(onTaskbarDrag, 16);
}

function onTaskbarDrag() {
  if (!win || win.isDestroyed()) return stopTaskbarDrag(false);
  // The renderer can't report mouseup once the cursor leaves our non-activating
  // window, so we poll the physical button state instead.
  if (!taskbarWin.isLeftMouseDown()) return stopTaskbarDrag(true);
  const layout = taskbarWin.getLayout();
  const b = win.getBounds();
  let x = screen.getCursorScreenPoint().x - dragGrabDX;
  if (layout) {
    const tb = screen.screenToDipRect(null, rectXYWH(layout.taskbarRect));
    x = Math.max(tb.x, Math.min(x, tb.x + tb.width - b.width));
  }
  win.setBounds({ x: Math.round(x), y: b.y, width: b.width, height: b.height });
  if (taskbarHwnd) taskbarWin.assertTopmost(taskbarHwnd);
}

function stopTaskbarDrag(snap) {
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
  draggingTaskbar = false;
  if (!snap || !win || win.isDestroyed()) return;
  // Choose the side from the widget's center relative to the taskbar center,
  // persist it, then snap to that side's anchor.
  const layout = taskbarWin.getLayout();
  if (layout) {
    const tb = screen.screenToDipRect(null, rectXYWH(layout.taskbarRect));
    const b = win.getBounds();
    config.taskbarSide = b.x + b.width / 2 < tb.x + tb.width / 2 ? 'left' : 'right';
    saveConfig(config);
  }
  positionTaskbarWidget();
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
    // The widget is now a normal window we position ourselves, so anchor the
    // popover directly above its current bounds.
    if (!win || win.isDestroyed()) return;
    const wb = win.getBounds();
    popover.setBounds({
      x: Math.round(wb.x),
      y: Math.round(wb.y) - pb.height - 6,
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
  if (draggingTaskbar) return; // don't pop the detail card mid-drag
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
ipcMain.on('taskbar:dragStart', startTaskbarDrag);

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
  if (taskbarTimer) clearInterval(taskbarTimer);
  if (dragTimer) clearInterval(dragTimer);
});
