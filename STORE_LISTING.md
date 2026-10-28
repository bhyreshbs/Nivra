# Store submission cheat sheet

Live listing: https://microsoftedge.microsoft.com/addons/detail/kecobckfpgekkaempmadljlmfplkbalp

| Store | Status | Upload |
|---|---|---|
| Microsoft Edge Add-ons | Published | `nivra-<version>.zip` (`npm run package`) |
| Opera Add-ons | Submitted 28 Oct 2026, awaiting moderation | `nivra-opera-<version>.zip` (`npm run package:opera`) |
| Firefox Add-ons (AMO) | Ready to submit | `nivra-firefox-<version>.zip` (`npm run package:firefox`) + source zip |
| Chrome Web Store | Coming soon | `nivra-<version>.zip` |

The Name, descriptions, category and search terms below are shared by every store. Each store's own notes follow.

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

Per-store tip line (replace the one above):
- Opera: `Tip: to open PDFs saved on your computer by double-clicking them, turn on "Allow access to file URLs" for Nivra in opera://extensions.`
- Firefox: `Tip: allow Nivra's site access when the popup asks so PDF links open in Nivra. Firefox keeps local files in its own viewer; drop one on the Nivra popup to read it in Nivra.`

## Category
Productivity (Opera: Productivity; Firefox: "Appearance" or "Other", plus the "Productivity" tag if offered)

## Search terms (≤7)
pdf, dark mode, pdf viewer, night mode, invert, reader, accessibility

---

## Microsoft Edge: notes for certification (paste into "Notes for certification")
Nivra replaces the browser's built-in PDF viewer by redirecting navigations to .pdf URLs (declarativeNetRequest) to its own viewer page, which renders the file with a bundled copy of PDF.js (Apache-2.0). `host_permissions` are limited to URLs ending in .pdf (http, https, file) — needed to read the document. `storage` holds user settings; `activeTab` lets the popup detect a PDF in the current tab. No remote code, no network requests other than the user's own PDF download, no analytics. `wasm-unsafe-eval` in the CSP is required by PDF.js's WebAssembly image decoders (JPEG2000/JBIG2/color management).

On first install Nivra opens a static welcome page, and it registers an uninstall URL for a static goodbye page, both on bhyreshbs.github.io/Nivra (hosted by GitHub Pages). Only the extension version and browser family are in the URL; there are no analytics. On Edge a `tabs.onUpdated` fallback redirects tabs that still show a .pdf URL; it uses the existing host permissions and adds none.

To test: open any https://…/file.pdf link — it should open in Nivra. Toggle Nivra off in the toolbar popup to restore the browser viewer. Drop a PDF on the popup's "Open a PDF" area to open a local file.

---

## Opera Add-ons (addons.opera.com)

Free. Sign in at https://addons.opera.com/developer/, **Upload new extension**, choose `nivra-opera-<version>.zip` from `npm run package:opera`.

- **Why a separate zip:** Opera's uploader rejects some binary file types PDF.js ships ("Invalid type on file: pdfjs/web/standard_fonts/FoxitDingbats.pfb"). The Opera package is the Chromium package with PDF.js's standard fonts and CMaps stored as base64 text (`<file>.txt`, decoded by `viewer/binary-data.js`) and the CMYK ICC profile left out (PDF.js then uses its built-in CMYK conversion). Do not upload `nivra-<version>.zip` to Opera.

- Before uploading, check Opera's Chromium version (`opera://about`) is at least `minimum_chrome_version` in `manifest.json` (147). If Opera is behind, Opera users cannot install it; wait, or lower the minimum in a separate Chromium release after testing.
- Screenshots: 1280×800 (reuse the Edge ones). Icon: `assets/nivra-300.png` scaled as requested.
- Opera may ask for sources of minified code: the only minified-looking files are PDF.js (`pdfjs/`, unmodified `pdfjs-dist@6.2.108` from npm; fonts and CMaps base64-encoded by `package-opera.js`) and the Tailwind output `viewer/viewer.css` (from `viewer/input.css`). Point them to the GitHub repo and `npm ci && npm run build && npm run package:opera`.

**Notes for the moderator (paste)**
Nivra replaces Opera's built-in PDF viewer by redirecting navigations to .pdf URLs (declarativeNetRequest) to its own viewer page, which renders the file with a bundled, unmodified copy of PDF.js (Apache-2.0). Because Opera's own viewer can win the race against that rule, a `tabs.onUpdated` listener (no extra permission) redirects tabs that still show a .pdf URL. `host_permissions` are limited to URLs ending in .pdf (http, https, file) — needed to read the document. `storage` holds user settings; `activeTab` lets the popup detect a PDF in the current tab. `wasm-unsafe-eval` in the CSP is required by PDF.js's WebAssembly image decoders. No remote code, no analytics. The welcome and uninstall pages are static pages on bhyreshbs.github.io/Nivra and receive only the version and `b=opera`.
To test: open any https://…/file.pdf link — it opens in Nivra; toggle Nivra off in the popup to get Opera's viewer back. For local PDFs enable "Allow access to file URLs" on opera://extensions, or drop a PDF on the popup.

---

## Firefox Add-ons (addons.mozilla.org)

Free. Sign in at https://addons.mozilla.org/developers/, **Submit a New Add-on**, "On this site", upload `nivra-firefox-<version>.zip`.

- Add-on id: `nivra@bhyresh.me` (`manifest.firefox.json`). It is permanent once the first version is uploaded.
- Minimum Firefox 140 (desktop) / 142 (Android); `data_collection_permissions: none` is declared in the manifest.
- **Source code:** answer "Yes" to "Do you need to submit source code?" (PDF.js and the Tailwind CSS are machine-generated) and upload `nivra-source-<version>.zip`.
- **Build the upload from that source zip**, not from your working copy. On Windows `core.autocrlf=true` checks files out with CRLF, while the archive (and the reviewer) has LF, so a zip built from the working copy would differ from the reviewer's build in every text file:
  ```
  git tag v<version> && git archive --format=zip -o nivra-source-<version>.zip v<version>
  rm -rf ../nivra-amo && mkdir ../nivra-amo && git archive v<version> | tar -x -C ../nivra-amo
  cd ../nivra-amo && npm ci && npm run build && npm run package:firefox
  ```
  Upload `../nivra-amo/nivra-firefox-<version>.zip` and `nivra-source-<version>.zip`.
- Run `npx web-ext lint --source-dir dist-firefox` first. Expected: 0 errors and 4 `UNSAFE_VAR_ASSIGNMENT` warnings, all inside unmodified PDF.js files (`pdfjs/build/pdf.mjs`, `pdfjs/build/pdf.worker.mjs`, `pdfjs/web/pdf_viewer.mjs` ×2).
- Privacy policy: https://bhyreshbs.github.io/Nivra/privacy.html. Support email: support@bhyresh.me. Homepage: https://bhyresh.me.
- Licence: choose the one in `LICENSE`.

**Notes to reviewer (paste into "Notes to Reviewer")**

What it does: Nivra replaces Firefox's built-in PDF viewer with its own viewer page (viewer/viewer.html), which renders PDFs locally with a bundled copy of PDF.js and recolours them (dark, invert, grayscale, high contrast). The original file is never modified or uploaded.

Permissions:
- `webRequest` + `webRequestBlocking`: background/sw.firefox.js redirects main_frame requests whose URL path ends in .pdf to viewer/viewer.html?file=<url> while the user has Nivra switched on. Nothing else is inspected or changed.
- Host permissions `*://*/*.pdf*` (and the .PDF / .Pdf variants): needed for that redirect and for the viewer to download the PDF. No other URLs are requested. The popup asks the user to grant them (permissions.request) because Firefox treats MV3 host permissions as opt-in.
- `storage`: user settings (on/off, display mode, brightness, contrast, per-site look). Never transmitted.
- `activeTab`: the popup checks whether the current tab is a PDF to offer "Open in Nivra".
- CSP `wasm-unsafe-eval`: required by PDF.js's WebAssembly image decoders (JPEG2000, JBIG2, colour management), all shipped in pdfjs/web/wasm/. No remote code, no eval.
- No data collection (data_collection_permissions: none). The only network requests are the user's own PDF downloads. On first install a static welcome page is opened and an uninstall URL is set, both on bhyreshbs.github.io/Nivra (GitHub Pages); the URL carries only the version and b=firefox.

Local files: Firefox does not expose file:// URLs to webRequest or to extension pages, so local PDFs stay in Firefox's viewer. Users can open one in Nivra by dropping it on the popup (read as a File and handed to the viewer through IndexedDB).

Third-party code (unmodified, verifiable against npm):
- pdfjs-dist 6.2.108 (Apache-2.0): pdfjs/build/pdf.mjs, pdfjs/build/pdf.worker.mjs, pdfjs/web/pdf_viewer.mjs, pdf_viewer.css, images, cmaps, standard_fonts, wasm, iccs. The 4 linter warnings are inside these files.
- @fontsource/inter 5.3.0 (OFL-1.1): viewer/fonts/inter/.
- viewer/viewer.css is generated by Tailwind CSS 4.3.3 from viewer/input.css.
All other JavaScript is hand-written, unminified source.

How to reproduce the build (from the uploaded source zip):
1. Node.js 24 (built with v24.15.0, npm 11.12.1). Windows, macOS or Linux; the zip step uses the system `tar` (bsdtar).
2. `npm ci` (exact versions from package-lock.json)
3. `npm run build` (generates viewer/viewer.css with Tailwind and copies PDF.js, fonts and decoders from node_modules)
4. `npm run package:firefox`
5. The extension files are in `dist-firefox/`, identical to the contents of the uploaded `nivra-firefox-<version>.zip` (the zip itself differs only in timestamps). The uploaded zip was built this way from this same source archive, and the build is deterministic: two clean builds produce byte-identical `dist-firefox/`.

To test: allow site access from the toolbar popup when prompted, then open any https://…/file.pdf link — it opens in Nivra. Switch Nivra off in the popup and reload: Firefox's own viewer is used. Drop a PDF on the popup's "Open a PDF" area to open a local file.

---

## Still needed from you (can't be generated)
- Store logo 300×300 PNG (`assets/Logo.png` can be resized) and 1–6 screenshots at 1280×800 (e.g. Smart Dark page, appearance panel, outline sidebar, popup). Take Firefox screenshots of the popup's site-access state for AMO.
- Optional: small promo tile 440×280 (draft at the bottom of `logo.html`), YouTube demo link.
- Developer accounts: Partner Center, Opera Add-ons and AMO (all free).

Privacy policy URL: https://bhyreshbs.github.io/Nivra/privacy.html
Website URL (optional): https://bhyresh.me
Support contact (optional): support@bhyresh.me (forwards to the owner's inbox; do not use a personal address)
Logo: `assets/nivra-300.png` (300×300). Rebuild before uploading: `npm run build` then `npm run package` (Edge), `npm run package:opera` (Opera) or `npm run package:firefox` (Firefox).
