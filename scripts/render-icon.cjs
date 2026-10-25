// Renders Keo's app icon (build/icon.png, 512x512) and the download page's icon (site/icon.png)
// from Keo's robot (src/renderer/src/assets/keo-robot.jpg) with Electron's own renderer: the robot
// in its studio light, in a rounded square with a soft rim.
// Usage: npx electron scripts/render-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const art = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'assets', 'keo-robot.jpg')).toString('base64');

const page = `<!doctype html><meta charset="utf-8"><body style="margin:0"><script>
window.icon = async () => {
  const img = new Image();
  img.src = 'data:image/jpeg;base64,${art}';
  await img.decode();
  const S = 512, R = 112;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d');
  const round = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
  round(8, 8, S - 16, S - 16, R);
  g.save();
  g.clip();
  g.fillStyle = '#0b0b0c';
  g.fillRect(0, 0, S, S);
  // The robot fills most of the square (it stands at about x 230-780, y 205-870 of the 1080 photo).
  const side = 720, cx = 506, cy = 528;
  g.drawImage(img, cx - side / 2, cy - side / 2, side, side, 8, 8, S - 16, S - 16);
  // A gentle vignette for depth.
  const v = g.createRadialGradient(S / 2, S / 2 - 30, S * 0.22, S / 2, S / 2, S * 0.66);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.38)');
  g.fillStyle = v;
  g.fillRect(0, 0, S, S);
  g.restore();
  round(9, 9, S - 18, S - 18, R - 1);
  g.lineWidth = 5;
  g.strokeStyle = 'rgba(255,255,255,0.07)';
  g.stroke();
  return c.toDataURL('image/png').split(',')[1];
};
</script>`;

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false });
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
    const png = Buffer.from(await win.webContents.executeJavaScript('icon()'), 'base64');
    fs.writeFileSync(path.join(root, 'build', 'icon.png'), png);
    fs.writeFileSync(path.join(root, 'site', 'icon.png'), png);
    console.log('wrote build/icon.png and site/icon.png', png.length, 'bytes');
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
