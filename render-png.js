// Generates the app icons and the macOS menu bar template icon.
// Run with: npm run icons
const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const APP_SIZE = 1024;
const buildDir = path.join(__dirname, 'build');
const assetsDir = path.join(__dirname, 'assets');
const svgPath = path.join(buildDir, 'icon.svg');
const appPngPath = path.join(buildDir, 'icon.png');
const appIcnsPath = path.join(buildDir, 'icon.icns');

const traySvg = `
<svg width="36" height="36" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg">
  <path fill="#000" d="M18 3.5c-6.4 0-11.6 5.1-11.6 11.5 0 5.4 5.8 11.5 11.6 19 5.8-7.5 11.6-13.6 11.6-19C29.6 8.6 24.4 3.5 18 3.5Zm0 16.8a5.3 5.3 0 1 1 0-10.6 5.3 5.3 0 0 1 0 10.6Z"/>
</svg>`;

app.disableHardwareAcceleration();

function ensureDirs() {
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });
}

async function renderSvgToImage(win, svg, size) {
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    `*{margin:0;padding:0}html,body{width:${size}px;height:${size}px;` +
    'background:transparent;overflow:hidden}svg{display:block;width:100%;height:100%}</style></head>' +
    `<body>${svg}</body></html>`;

  win.setContentSize(size, size);
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 700));
  const img = await win.webContents.capturePage();
  return img.resize({ width: size, height: size });
}

function writePng(file, image) {
  fs.writeFileSync(file, image.toPNG());
}

function createIcns(masterPng) {
  if (process.platform !== 'darwin') {
    console.warn('Skipping build/icon.icns: iconutil is only available on macOS.');
    return;
  }

  const iconsetDir = path.join(buildDir, 'icon.iconset');
  fs.rmSync(iconsetDir, { recursive: true, force: true });
  fs.mkdirSync(iconsetDir, { recursive: true });

  const master = nativeImage.createFromBuffer(masterPng);
  const sizes = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024],
  ];

  for (const [name, size] of sizes) {
    writePng(path.join(iconsetDir, name), master.resize({ width: size, height: size }));
  }

  execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', appIcnsPath], { stdio: 'inherit' });
  fs.rmSync(iconsetDir, { recursive: true, force: true });
}

app.whenReady().then(async () => {
  ensureDirs();

  const win = new BrowserWindow({
    width: APP_SIZE,
    height: APP_SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { backgroundThrottling: false },
  });

  const appSvg = fs.readFileSync(svgPath, 'utf8');
  const appImage = await renderSvgToImage(win, appSvg, APP_SIZE);
  const appPng = appImage.toPNG();
  fs.writeFileSync(appPngPath, appPng);
  fs.writeFileSync(path.join(assetsDir, 'icon.png'), appPng);

  const tray2x = await renderSvgToImage(win, traySvg, 36);
  writePng(path.join(assetsDir, 'trayTemplate@2x.png'), tray2x);
  writePng(path.join(assetsDir, 'trayTemplate.png'), tray2x.resize({ width: 18, height: 18 }));

  win.destroy();
  createIcns(appPng);

  console.log('Wrote app icons and macOS tray template icons');
  app.quit();
});
