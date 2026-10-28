# Nivra — Maintenance Guide

A routine for keeping Nivra healthy. Do a full cycle every **3–4 months**, and the quick checks monthly.

## Calendar

| When | What |
|---|---|
| Monthly | Read store reviews and `support@bhyresh.me`; check GitHub issues; confirm the privacy page and support address still work |
| Every 3–4 months | Update dependencies, run the test checklist, ship a patch or small feature |
| Yearly | Review the privacy policy, store text and screenshots for accuracy; check the licence notices |

## Quarterly cycle

### 1. Update dependencies
```
npm outdated
npm audit
npm update pdfjs-dist       # PDF.js fixes rendering and security bugs often
npm run build
npm test
```
After a PDF.js upgrade, open several different PDFs: a text document with an outline, a scanned file, one with images and a watermark, one with forms, and a CJK or non-Latin file. Check nothing renders blank (WASM decoders, fonts and cmaps are copied by `build.js`).

### 2. Watch for platform changes
- Chrome Extensions "What's new" and the Manifest V3 / `declarativeNetRequest` notes
- Microsoft Edge Add-ons developer policies
- Opera: its Chromium version (`opera://about`) must stay at or above `minimum_chrome_version` in `manifest.json`
- Firefox: the Extension Workshop blog and AMO policies (blocking `webRequest` in MV3, host-permission prompts, `data_collection_permissions`), and the current ESR (bump `strict_min_version` in `manifest.firefox.json` only when needed)
- Anything that changes how PDF navigations are handled or how file URLs are permitted

### 3. Test checklist (≈20 min in Edge and Chrome, plus ≈10 min each in Opera and Firefox)
Load `dist/` unpacked (`npm run package` first), then check:

- [ ] A web PDF opens in Nivra; turning Nivra off in the popup restores the browser viewer
- [ ] A local PDF opens (with "Allow access to file URLs" on) and via the popup drop zone / picker
- [ ] Smart Dark: photos stay in colour on a normal document, on a document with a diagonal watermark, and on a scanned page; thumbnails match
- [ ] All five modes, the profiles, brightness / contrast; settings restored after reload
- [ ] "Remember for this site" (web) and "for local files"
- [ ] Outline tab (on a PDF with bookmarks and one without), search, zoom, fit, two-page view, rotate (button + R)
- [ ] Print, download transformed copy, document properties
- [ ] Bottom bar collapse / expand; Appearance button label animation and mode swap
- [ ] Fresh install opens the welcome page; removing the extension opens the goodbye page (both load from GitHub Pages)
- [ ] With "Allow access to file URLs" off, the popup shows the banner; with it on, the banner is gone
- [ ] No red errors in the viewer console (F12) and none under the extension's Errors on `edge://extensions`
- [ ] `npm test` passes
- [ ] `node tests/baseline-check.js` shows only the files you meant to change in the Chromium package (then `--update` it)

**Opera** (load `dist/` on `opera://extensions`):
- [ ] A web PDF opens in Nivra; toggling off restores Opera's viewer
- [ ] A local PDF opens with "Allow access to file URLs" on; the popup banner and "File URL Access" button open `opera://extensions`
- [ ] Popup says "Opera"; the welcome page names Opera and its cube Extensions button; the goodbye page shows the Opera store line

**Firefox** (`npm run package:firefox`, then `npx web-ext run --source-dir dist-firefox`):
- [ ] `npx web-ext lint --source-dir dist-firefox`: 0 errors (4 known PDF.js warnings)
- [ ] Popup asks for site access; after "Allow site access" a web PDF opens in Nivra
- [ ] Toggling off and reloading gives Firefox's viewer; toggling on with a web PDF tab open moves it into Nivra
- [ ] A local PDF stays in Firefox's viewer, the popup shows the drop-zone hint, and dropping it on the popup opens it in Nivra
- [ ] Welcome page shows the Firefox steps; uninstalling opens the goodbye page with the Firefox store line

### 4. Housekeeping
- Review store reviews (anything under 3 stars is an early warning) and note repeat complaints
- Confirm `https://bhyreshbs.github.io/Nivra/privacy.html` loads and shows the current contact address
- Send a test mail to `support@bhyresh.me` and confirm it arrives
- Keep `package.json`, `manifest.json` and `manifest.firefox.json` versions identical (and the `v…` label in `popup/popup.html`); `npm run package:firefox` refuses mismatched manifests
- Confirm `welcome.html` and `goodbye.html` load under `https://bhyreshbs.github.io/Nivra/` (`SITE_URL` in `background/sw.js`)
- Live Edge listing: https://microsoftedge.microsoft.com/addons/detail/kecobckfpgekkaempmadljlmfplkbalp

## Releasing an update

1. Bump `version` in `manifest.json`, `manifest.firefox.json` and `package.json`
   (patch `1.7.1` for fixes, minor `1.8.0` for features). Every browser always ships the same version.
2. `npm test`, `npm run build`, `npm run package`, `npm run package:firefox`.
3. Load `dist/` (Edge, Opera) and `dist-firefox/` (Firefox) and run the checklist above.
4. Commit, then tag the release: `git tag v<version>`.
5. **Edge:** Partner Center → the extension → **Update** → upload `nivra-<version>.zip`, update the listing text/screenshots if anything visible changed, add certification notes (see `STORE_LISTING.md`), then submit.
6. **Opera:** addons.opera.com developer dashboard → Nivra → upload the same `nivra-<version>.zip` as a new version.
7. **Firefox:** build the upload from the tagged source (not the working copy; see "Firefox Add-ons" in `STORE_LISTING.md` for why and the exact commands), then AMO → Nivra → **Upload New Version** → `nivra-firefox-<version>.zip` plus `nivra-source-<version>.zip`, with the reviewer notes.
8. Push: `git push && git push --tags`.

Notes:
- Do not resubmit while a version is in review; it restarts the review.
- Partner Center, Opera and AMO all reject a version number that was already used.
- AMO reviews each version and may ask for the source zip again; keep the tagged commit.
- Avoid new permissions. A new permission can disable the extension for existing users until they approve it, and it triggers a fuller review.
- Never load remote code (scripts, wasm, or `eval`). Everything must ship in the package.

## Roadmap ideas

**Next 3–4 months**
- Smart Dark tuning from real-world PDFs that misbehave (charts with labels, partly dark pages, scans)
- Remember the last page read per document
- Sepia / custom tint mode
- Print options (page range, ink-saving)
- More languages in `_locales/` (Hindi, Spanish, German, French)

**Later**
- Structure-preserving export (selectable text in a recoloured copy; needs a PDF-writing library)
- Local highlights and notes
- Customisable shortcuts and a settings page
- Automated viewer tests in a headless browser
- Other formats (EPUB, images)

## Things to keep in good order

| Item | Where |
|---|---|
| Store listing text, search terms, certification and reviewer notes (Edge, Opera, AMO) | `STORE_LISTING.md` |
| Firefox manifest and background script | `manifest.firefox.json`, `background/sw.firefox.js` (Chromium: `manifest.json`, `background/sw.js`) |
| Chromium package baseline | `tests/baseline.json` (`node tests/baseline-check.js --update` after an intended release) |
| Privacy policy (source and published page) | `PRIVACY.md`, `docs/privacy.html` (GitHub Pages from `/docs`) |
| Logo, store images, promo tile | `assets/`, `logo.html` (`node make-promo-shot.js` regenerates the helper) |
| Contact address | `support@bhyresh.me` (Cloudflare Email Routing → owner's inbox) |
| Licences | `LICENSE`; PDF.js (Apache-2.0) and Inter (OFL-1.1) keep their own notices in the package |

## When something breaks

1. Reproduce with `?nivraDebug=1&file=<pdf url>` added to the viewer address (the `file=` part must stay last) to see how Smart Dark classified each image (orange = inverted, red = preserved).
2. Fix, add a test if the logic is testable (`tests/`), and ship a patch release.
3. If a release is badly broken, upload the previous version's zip as a new, higher version number. Store versions cannot be reused.
