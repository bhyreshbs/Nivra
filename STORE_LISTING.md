# Microsoft Edge Add-ons — submission cheat sheet

Upload: `nivra-<version>.zip` from `npm run package`.

## Name
Nivra: Dark Mode PDF Viewer

## Short description (≤132 chars)
Read PDFs in Dark Mode, Invert, Grayscale or High Contrast. Local-first: your files never leave your device.

## Long description
Nivra opens PDFs in a fast, local viewer that makes them easier on your eyes — without ever changing the original file.

**Display modes**
- Smart Dark — dark pages with photos, charts and diagrams kept in their real colors, on the page and in the thumbnails
- Original, True Invert, Grayscale and High Contrast
- Brightness and contrast sliders
- One-click profiles: Reading, Night, Study, Focus, Original
- "Remember for this site" (or for local files) to keep a look per website
- Your last settings are restored every time

**A complete viewer**
- Page thumbnails and an outline (bookmarks) panel
- Search, zoom, fit-to-page/width (opens fit to page), two-page view, rotate
- Document properties, print, and download a transformed copy
- Open any local PDF by dropping it on the Nivra popup
- A compact bottom bar that collapses out of the way
- Keyboard shortcuts (Ctrl+F search, Ctrl+B sidebar, R rotate, Ctrl+P print)

**Private by design**
Everything happens on your device. No accounts, no uploads, no analytics, no remote code.

Tip: to open PDFs saved on your computer by double-clicking them, turn on "Allow access to file URLs" for Nivra in edge://extensions.

## Category
Productivity

## Search terms (≤7)
pdf, dark mode, pdf viewer, night mode, invert, reader, accessibility

## Notes for certification (paste into "Notes for certification")
Nivra replaces the browser's built-in PDF viewer by redirecting navigations to .pdf URLs (declarativeNetRequest) to its own viewer page, which renders the file with a bundled copy of PDF.js (Apache-2.0). `host_permissions` are limited to URLs ending in .pdf (http, https, file) — needed to read the document. `storage` holds user settings; `activeTab` lets the popup detect a PDF in the current tab. No remote code, no network requests other than the user's own PDF download, no analytics. `wasm-unsafe-eval` in the CSP is required by PDF.js's WebAssembly image decoders (JPEG2000/JBIG2/color management).

To test: open any https://…/file.pdf link — it should open in Nivra. Toggle Nivra off in the toolbar popup to restore the browser viewer. Drop a PDF on the popup's "Open a PDF" area to open a local file.

## Still needed from you (can't be generated)
- Privacy policy URL: host `PRIVACY.md` (GitHub Pages, a gist, your site) and fill in the contact line first.
- Store logo 300×300 PNG (`assets/Logo.png` can be resized) and 1–6 screenshots at 1280×800 (e.g. Smart Dark page, appearance panel, outline sidebar, popup).
- Optional: small promo tile 440×280 (draft at the bottom of `logo.html`), YouTube demo link.
- Publisher account on Partner Center (free).

Privacy policy URL: https://bhyreshbs.github.io/Nivra/privacy.html
Website URL (optional): https://bhyresh.me
Logo: `assets/nivra-300.png` (300×300). Rebuild the zip with `npm run build && npm run package` before uploading.
