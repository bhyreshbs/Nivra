// Generates promo-shot.js: the Smart Dark screenshot as a data URL, so logo.html can
// export the 1400x560 promo tile to PNG when opened straight from disk (file://).
// Run: node make-promo-shot.js
const fs = require('fs');
const b64 = fs.readFileSync('assets/Screenshots/1-1280x800.png').toString('base64');
fs.writeFileSync('promo-shot.js', `window.PROMO_SHOT = "data:image/png;base64,${b64}";\n`);
console.log('promo-shot.js written,', fs.statSync('promo-shot.js').size, 'bytes');
