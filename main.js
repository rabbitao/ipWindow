const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, net, session } = require('electron');
const path = require('path');
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
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');

// ---------- i18n ----------
// Detect the OS UI language. Chinese locales use Chinese; everything else
// falls back to English.
const STRINGS = {
  zh: {
    apiLang: 'zh-CN',
    trayShow: '显示面板',
    trayRefresh: '立即刷新',
    trayQuit: '退出',
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

let win = null;
let tray = null;
let refreshTimer = null;

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

async function refreshAndSend() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('ip:loading');
  try {
    const info = await fetchIpInfo();
    win.webContents.send('ip:update', { ...info, time: Date.now() });
  } catch (e) {
    win.webContents.send('ip:error', { message: e.message, time: Date.now() });
  }
}

// ---------- Window ----------
function createWindow() {
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
    // Push the localized strings before the first refresh so the UI labels
    // render in the right language.
    win.webContents.send('i18n', {
      ipLoading: t.ipLoading,
      labelLoc: t.labelLoc,
      closeTitle: t.closeTitle,
      unknownLoc: t.unknownLoc,
      updatePrefix: t.updatePrefix,
      queryFailed: t.queryFailed,
      networkError: t.networkError,
    });
    refreshAndSend();
  });

  // Refresh every 5 minutes.
  refreshTimer = setInterval(refreshAndSend, 5 * 60 * 1000);
}

// ---------- Tray (right-click to refresh / quit) ----------
function createTray() {
  let icon = nativeImage.createFromPath(ICON_PATH);
  if (!icon.isEmpty()) {
    // Tray icons are tiny; scale the master image down so it renders crisply.
    icon = icon.resize({ width: 32, height: 32 });
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
  const menu = Menu.buildFromTemplate([
    { label: t.trayShow, click: showWindow },
    { label: t.trayRefresh, click: () => refreshAndSend() },
    { type: 'separator' },
    { label: t.trayQuit, click: () => app.quit() },
  ]);
  // Double-clicking the tray icon also brings the widget back.
  tray.on('double-click', showWindow);
  tray.setToolTip(t.tooltip);
  tray.setContextMenu(menu);
}

// Manual refresh triggered from the renderer (e.g. double-click).
ipcMain.on('ip:refresh', () => refreshAndSend());
ipcMain.on('app:quit', () => app.quit());

app.whenReady().then(() => {
  // Resolve UI language from the OS locale (Chinese → zh, otherwise English).
  t = app.getLocale().toLowerCase().startsWith('zh') ? STRINGS.zh : STRINGS.en;

  // Follow the OS proxy configuration so the IP lookup reflects the proxy.
  session.defaultSession.setProxy({ mode: 'system' }).catch(() => {});

  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (refreshTimer) clearInterval(refreshTimer);
});
