// electron-builder afterPack hook: remove Electron's sample app, which is copied
// along with the custom electronDist but is never needed by Keo.
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const target = path.join(context.appOutDir, 'resources', 'default_app.asar');
  if (fs.existsSync(target)) fs.rmSync(target);
};
