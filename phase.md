# Nivra: Firefox and Opera support - phased plan

## Ground rules (apply to every phase)
- Chrome and Edge behavior MUST NOT change. The existing `manifest.json`, the Chrome/Edge paths in `background/sw.js`, and the Edge build stay behaviorally identical.
- All new behavior is gated on browser detection (`_isFirefox`, `_isOpera`) or lives in new files / build targets.
- Firefox gets its own manifest (e.g. `manifest.firefox.json`). The existing `manifest.json` is not edited for Firefox.
- Opera reuses the Chromium manifest/build; only detection, wording and links differ.
- After each phase: run the existing tests (`tests/`) and confirm the Chrome/Edge build output is unchanged (diff the zip contents).
- Commit once per phase. Do not push unless asked.

---

## Phase 0 - Baseline and safety net
Goal: prove later phases don't alter Chrome/Edge.
Tasks:
- Build the current Chrome/Edge package and record the file list and hashes as a baseline.
- Add a script that rebuilds and compares against the baseline.

Prompt:
> Read build.js and package.js. Build the current Chrome/Edge package without changing any source. Write a script `tests/baseline-check.js` that lists every file in the built package with a SHA-256 hash, saves the result to `tests/baseline.json`, and can be re-run to report any differences. Do not modify extension source files. Run it and show the result.

## Phase 1 - Browser detection helper
Goal: one shared way to identify Firefox / Opera / Edge / Chrome.
Tasks:
- New file (e.g. `shared/browser.js`) exporting `isFirefox`, `isOpera`, `isEdge`, `browserName`, and an `extensionsPageUrl()` helper.
- Opera: UA contains `OPR/`. Firefox: UA contains `Firefox/`.
- Edge and Chrome results must be identical to today's logic.

Prompt:
> Create `shared/browser.js` with browser detection for Chrome, Edge, Opera (UA `OPR/`) and Firefox, plus a helper returning the right extensions page URL (chrome://extensions, edge://extensions, opera://extensions, about:addons). Keep the existing Edge detection regex exactly as it is in background/sw.js. Do NOT change background/sw.js or popup/popup.js yet. Add unit tests under tests/ for the UA strings of all four browsers.

## Phase 2 - Opera support (Chromium path)
Goal: Opera works using the existing Chromium build.
Tasks:
- Detect Opera in `background/sw.js` and `popup/popup.js`; reuse the Edge-style tab fallback for Opera (its built-in viewer can race the DNR redirect).
- Send `b=opera` to the install/uninstall pages; add Opera wording to the welcome/goodbye pages.
- Popup: Opera name, `opera://extensions` link, and file-access banner wording.
- Review `minimum_chrome_version` (147) against the oldest Opera you want to support, but do NOT change manifest.json without asking.

Prompt:
> Add Opera support without changing Chrome/Edge behavior. In background/sw.js, add an `_isOpera` flag (UA `OPR/`) and enable the same tab-update fallback and file-access check that Edge uses, only when `_isOpera` is true. Make `_sitePage` send `b=opera` for Opera. In popup/popup.js show "Opera", an `opera://extensions/?id=` link and the file-access banner for Opera. Update the docs welcome and goodbye pages for Opera wording. Every Chrome and Edge code path must stay identical; show me the diff so I can confirm. Run tests and tests/baseline-check.js (only files I expected to change should differ).

## Phase 3 - Firefox manifest and build target
Goal: a separate Firefox package.
Tasks:
- Create `manifest.firefox.json` (or a generator step): `background.scripts` instead of `service_worker`; `browser_specific_settings.gecko` (id, `strict_min_version`); remove `minimum_chrome_version` / `offline_enabled`; adjust `web_accessible_resources`; keep the CSP valid.
- Add `npm run package:firefox` that outputs a separate zip. Existing scripts stay untouched.

Prompt:
> Add a Firefox build target without touching manifest.json or existing build outputs. Create `manifest.firefox.json` from manifest.json: use `background.scripts` (event page) instead of `service_worker`, add `browser_specific_settings.gecko` with an id and `strict_min_version`, drop Chrome-only keys, and make web_accessible_resources Firefox-compatible. Update build.js/package.js (or add build-firefox.js) so `npm run package:firefox` creates `nivra-firefox-<version>.zip`, while the existing Chrome/Edge command output is unchanged. Verify with tests/baseline-check.js.

## Phase 4 - Firefox PDF interception
Goal: when Nivra is enabled, PDFs open in Nivra; when disabled, Firefox's default viewer is used.
Tasks:
- Firefox-only background script using `webRequest.onBeforeRequest` (blocking) to redirect `.pdf` main-frame navigations to `viewer/viewer.html?file=...`. Permissions `webRequest` and `webRequestBlocking` go in the Firefox manifest only.
- Same enable/disable toggle via `storage.local` (`nivraEnabled`); register/unregister the listener on toggle.
- Reuse the existing URL regex (case-insensitive, query/fragment aware).
- Stretch: Content-Type based detection for PDFs served without a `.pdf` extension.

Prompt:
> Implement PDF interception for Firefox only, in a new file `background/sw.firefox.js` referenced only by manifest.firefox.json. Use webRequest.onBeforeRequest (blocking) to redirect main_frame requests whose URL matches the same regex as PDF_URL_RE in background/sw.js to `runtime.getURL('viewer/viewer.html')?file=<url>`. Honour the nivraEnabled storage flag (default true), handle the SET_ENABLED message from the popup the way sw.js does, and re-apply on startup/install. Do not modify background/sw.js. Add tests for the URL matching and the toggle logic.

## Phase 5 - Firefox viewer and popup compatibility
Goal: viewer, popup and settings run on Firefox.
Tasks:
- Audit `viewer/`, `popup/`, `settings/`, `pdfjs/` for `chrome.*` calls, `chrome.extension.isAllowedFileSchemeAccess`, module/worker usage and WASM under Firefox's CSP.
- Use feature detection (`browser ?? chrome`) only where required, in a way that behaves identically on Chromium.
- Popup: Firefox name, `about:addons` link, and a Firefox-appropriate message instead of the file-access banner.
- pdf.js worker loading from `moz-extension://`.

Prompt:
> Audit viewer/, popup/ and settings/ for anything that breaks on Firefox: chrome.extension.isAllowedFileSchemeAccess, chrome://extensions links, extension-origin assumptions, workers and WASM. List the findings first, then fix them using feature detection so Chrome/Edge/Opera behave exactly as before. In the popup show a Firefox-specific message instead of the file-access banner. Run all tests and tests/baseline-check.js.

## Phase 6 - Local file (file://) behavior on Firefox
Goal: decide and document what is possible.
Tasks:
- Test whether `file://` PDFs can be intercepted/read in Firefox.
- If not, show a clear note in the popup/README and let Firefox's viewer handle them.

Prompt:
> Test whether the Firefox build can intercept and read file:// PDFs. Report what works and what does not. Based on the result, implement the cleanest fallback (clear popup message and README note, local files left to Firefox's viewer) without affecting other browsers.

## Phase 7 - Store pages, docs and localisation
Tasks:
- Update `STORE_LISTING.md`, `README.md`, `PRIVACY.md`, `MAINTENANCE.md` with Firefox and Opera sections.
- Update docs pages for `b=firefox` and `b=opera`; add store links once approved.
- Add the AMO data-collection declaration and reviewer notes (build steps / source upload if minified).

Prompt:
> Update README.md, STORE_LISTING.md, PRIVACY.md and MAINTENANCE.md with Firefox and Opera sections: install, permissions justification, limitations (Firefox file://), build commands. Update the docs welcome and goodbye pages to handle `b=firefox` and `b=opera`. Prepare AMO reviewer notes explaining how to reproduce the build.

## Phase 8 - Test matrix and release
Tasks:
- Manual tests per browser: install, enable/disable toggle, http PDF, PDF with query/fragment, upper-case `.PDF`, incognito, uninstall page.
- Confirm the Chrome/Edge package is unchanged via the baseline check.
- Submit to AMO (free) and Opera Add-ons (free).

Prompt:
> Write a manual test checklist `tests/MANUAL_TESTS.md` covering Firefox and Opera (install, toggle on/off, http/https PDFs, query/fragment URLs, uppercase extension, incognito, file:// behavior, uninstall page). Then run the baseline check and confirm the Chrome/Edge package is unchanged. List the steps to submit the Firefox zip to AMO and the Opera zip to Opera Add-ons.
