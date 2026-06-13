// Rasterizes build/icon.svg to build/icon.png (1024x1024) using Electron's
// Chromium renderer — no native image libraries required.
// Run with: npm run icons
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const SIZE = 1024;
const buildDir = path.join(__dirname, 'build');
const svgPath = path.join(buildDir, 'icon.svg');
const outPath = path.join(buildDir, 'icon.png');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const svg = fs.readFileSync(svgPath, 'utf8');
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    `*{margin:0;padding:0}html,body{width:${SIZE}px;height:${SIZE}px;` +
    'background:transparent;overflow:hidden}svg{display:block}</style></head>' +
    `<body>${svg}</body></html>`;

  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { backgroundThrottling: false },
  });

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  // Let Chromium paint the SVG before capturing.
  await new Promise((r) => setTimeout(r, 700));

  const img = await win.webContents.capturePage();
  const png = img.toPNG();
  fs.writeFileSync(outPath, png);

  // Keep the runtime icon (used by the window + tray) in sync.
  const assetsDir = path.join(__dirname, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, 'icon.png'), png);

  console.log('Wrote', outPath, 'and assets/icon.png', img.getSize());
  app.quit();
});
