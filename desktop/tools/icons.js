// Copies the final FabriC++ mark from public/brand/ into desktop/assets/ so the shell and the
// installer use the exact same artwork as the web client. Never draw a new mark here.
const fs = require('node:fs');
const path = require('node:path');

const brand = path.join(__dirname, '..', '..', 'public', 'brand');
const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });
for (const [from, to] of [
  ['icon-512.png', 'icon.png'],      // app, window and installer icon (electron-builder makes the .ico/.icns)
  ['icon-32.png', 'tray.png'],       // tray
  ['fabric-icon.svg', 'fabric-icon.svg'], // boot screen
]) fs.copyFileSync(path.join(brand, from), path.join(out, to));
console.log('brand assets copied to desktop/assets/');
