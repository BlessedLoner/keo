// Rasterises build/icon.svg to build/icon.png (512x512) with Electron's own renderer.
// Usage: npx electron scripts/render-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'), 'utf8');

app.whenReady().then(async () => {
  try {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, useContentSize: true, backgroundColor: '#00000000', transparent: true });
  win.showInactive();
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 800));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), img.resize({ width: 512, height: 512 }).toPNG());
  console.log('wrote build/icon.png', img.getSize());
  app.exit(0);
  } catch (e) {
    console.error('icon render failed:', e && e.message);
    app.exit(1);
  }
});
setTimeout(() => {
  console.error('icon render timed out');
  app.exit(1);
}, 20000);
