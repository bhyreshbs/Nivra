# Changelog

Every browser (Edge, Chrome, Opera, Firefox) ships the same version number. Each release is also
listed, in user-facing wording, on `docs/update.html`, which Nivra opens after every update.
Add the new entry to both files when you bump the version.

## 1.7.1

- Setup window after install: red until "Allow access to file URLs" is on (Firefox: site access), turns green by itself.
- Red "!" badge on the toolbar icon and a red banner in the popup while that step is missing.
- Nivra opens `docs/update.html` after every update so users can see what changed.
- Goodbye page: working feedback form (Web3Forms).
- Separate store packages: `nivra-chromium-<version>.zip` (Edge, Chrome), `nivra-opera-<version>.zip`, `nivra-firefox-<version>.zip`; `npm run package:all` builds all three.

## 1.7.0

- Opera support (same code as Chromium; its own package with PDF.js fonts/CMaps base64-encoded for the Opera store).
- Firefox build: `webRequest` redirect, site-access prompt, local files left to Firefox's viewer.
- One shared version number for all browsers.

## 1.6.1

- Edge PDF fallback, popup file-access banner, welcome and goodbye pages.
