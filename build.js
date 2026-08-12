const fs = require('fs');
const path = require('path');

function copyDirStructure(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
}

const srcDir = path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build');
const destDir = path.join(__dirname, 'pdfjs', 'build');

const webSrcDir = path.join(__dirname, 'node_modules', 'pdfjs-dist', 'web');
const webDestDir = path.join(__dirname, 'pdfjs', 'web');

copyDirStructure(srcDir, destDir);
fs.copyFileSync(path.join(srcDir, 'pdf.mjs'), path.join(destDir, 'pdf.mjs'));
fs.copyFileSync(path.join(srcDir, 'pdf.worker.mjs'), path.join(destDir, 'pdf.worker.mjs'));

copyDirStructure(webSrcDir, webDestDir);
fs.copyFileSync(path.join(webSrcDir, 'pdf_viewer.mjs'), path.join(webDestDir, 'pdf_viewer.mjs'));
fs.copyFileSync(path.join(webSrcDir, 'pdf_viewer.css'), path.join(webDestDir, 'pdf_viewer.css'));

// copy images folder recursively
const imagesSrcDir = path.join(webSrcDir, 'images');
const imagesDestDir = path.join(webDestDir, 'images');
if (fs.existsSync(imagesSrcDir)) {
  fs.cpSync(imagesSrcDir, imagesDestDir, { recursive: true });
}

// Copy Inter font
const fontSrcDir = path.join(__dirname, 'node_modules', '@fontsource', 'inter');
const fontDestDir = path.join(__dirname, 'viewer', 'fonts', 'inter');
copyDirStructure(fontSrcDir, fontDestDir);
if (fs.existsSync(fontSrcDir)) {
  fs.cpSync(fontSrcDir, fontDestDir, { recursive: true });
}

// Copy standard_fonts (suppresses 'Cannot load system font' + standardFontDataUrl warnings)
const stdFontsSrc  = path.join(__dirname, 'node_modules', 'pdfjs-dist', 'standard_fonts');
const stdFontsDest = path.join(__dirname, 'pdfjs', 'web', 'standard_fonts');
if (fs.existsSync(stdFontsSrc)) {
  fs.cpSync(stdFontsSrc, stdFontsDest, { recursive: true });
}

// Copy CMaps (proper character map support for CJK and other encodings)
const cmapsSrc  = path.join(__dirname, 'node_modules', 'pdfjs-dist', 'cmaps');
const cmapsDest = path.join(__dirname, 'pdfjs', 'web', 'cmaps');
if (fs.existsSync(cmapsSrc)) {
  fs.cpSync(cmapsSrc, cmapsDest, { recursive: true });
}

console.log('Build dependencies copied successfully.');
