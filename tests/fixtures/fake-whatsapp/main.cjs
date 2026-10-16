// Disposable WhatsApp-like test application (no network, no real accounts).
// Writes its observable state to FAKE_WA_STATE so tests can check what Keo did.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const stateFile = process.env.FAKE_WA_STATE;
app.commandLine.appendSwitch('force-renderer-accessibility');
app.whenReady().then(async () => {
  // Placed on the monitor the test chooses (e.g. a scaled external monitor).
  const x = Number(process.env.FAKE_WA_X ?? 40);
  const y = Number(process.env.FAKE_WA_Y ?? 40);
  const win = new BrowserWindow({ width: 1200, height: 800, x, y, title: 'Fake WhatsApp — Keo test', show: true });
  win.on('page-title-updated', (e) => e.preventDefault());
  await win.loadFile(path.join(__dirname, 'index.html'));
  const write = async () => {
    if (win.isDestroyed()) return;
    const st = await win.webContents.executeJavaScript('JSON.stringify(window.__state)').catch(() => '{}');
    // Atomic replace, so the test never reads a half-written file.
    fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify({ pid: process.pid, ...JSON.parse(st) }));
    fs.renameSync(`${stateFile}.tmp`, stateFile);
  };
  await write();
  setInterval(() => void write(), 250);
  // Test-driven incoming messages: FAKE_WA_INBOX holds [{ from, text }, …]; new entries arrive as messages.
  const inbox = process.env.FAKE_WA_INBOX;
  let delivered = 0;
  if (inbox) {
    setInterval(() => {
      let list;
      try {
        list = JSON.parse(fs.readFileSync(inbox, 'utf8'));
      } catch {
        return;
      }
      for (; delivered < list.length; delivered++) {
        const m = list[delivered];
        void win.webContents.executeJavaScript(`window.__receive(${JSON.stringify(m.from)}, ${JSON.stringify(m.text)})`);
      }
    }, 300);
  }
  setTimeout(() => app.exit(0), 240000); // never outlive the test
});
