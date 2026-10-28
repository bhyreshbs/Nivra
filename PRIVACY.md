# Nivra — Privacy Policy

_Last updated: 28 October 2026_

Nivra is a PDF viewer extension for Microsoft Edge, Opera, Firefox and other Chromium browsers. It is built to work entirely on your device.

## What Nivra does with your documents

- PDFs are opened, rendered and recolored **locally in your browser**. They are never uploaded to Nivra or to any server run by the developer.
- When you open a PDF from a web address, your browser downloads it from that website exactly as it would without Nivra (using your normal cookies for that site, so PDFs behind a login still open).
- PDFs you choose or drop in the Nivra popup are held temporarily in your browser's local storage so the viewer tab can open them, then removed. Anything left behind is deleted within a day.
- Downloaded or printed "transformed" copies are generated on your device.

## What Nivra stores

Nivra saves a few settings in your browser (`chrome.storage.local`, `browser.storage.local` in Firefox): whether Nivra is turned on, your display mode, brightness, contrast, zoom, sidebar and toolbar state, and — if you tick "Remember for this site" — the appearance chosen for that website's hostname. This data stays on your device. It is not synced or transmitted. Removing the extension deletes it.

## What Nivra does not do

- No accounts, analytics, telemetry, advertising or tracking.
- No data is sold, shared or sent to third parties.
- No remote code is loaded; everything Nivra runs ships inside the extension package.

## Install and uninstall pages

After you install Nivra, it opens a welcome page; when you remove it, your browser opens a goodbye page. Both are static pages on this site. The address carries only the Nivra version and your browser family (Edge, Chrome, Opera or Firefox). Nothing about you or your documents is sent, and the pages have no analytics. The site host (GitHub Pages) may keep ordinary server logs.

## Permissions

**Microsoft Edge, Opera, Chrome and other Chromium browsers**

| Permission | Why |
|---|---|
| `declarativeNetRequest` / `declarativeNetRequestWithHostAccess` | Redirect navigations to PDF files into Nivra's viewer. |
| Host access to `*.pdf` URLs (web and `file://`) | Detect PDF addresses and read the PDF to display it. Nivra does not request access to other pages. |
| `storage` | Save the settings listed above. |
| `activeTab` | Let the toolbar popup see whether the current tab is a PDF so it can offer "Open in Nivra". |

**Firefox**

| Permission | Why |
|---|---|
| `webRequest` / `webRequestBlocking` | Redirect navigations to PDF files into Nivra's viewer while Nivra is switched on. No other requests are changed. |
| Host access to `*.pdf` web URLs | Detect PDF addresses and read the PDF to display it. Firefox asks you to allow this; Nivra does not request access to other pages or to files on your computer. |
| `storage` | Save the settings listed above. |
| `activeTab` | Let the toolbar popup see whether the current tab is a PDF so it can offer "Open in Nivra". |

Firefox does not let add-ons open files from your computer, so local PDFs stay in Firefox's own viewer unless you drop one on the Nivra popup.

## Contact

Questions about this policy: support@bhyresh.me
