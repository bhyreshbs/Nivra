# Nivra — Privacy Policy

_Last updated: 17 October 2026_

Nivra is a PDF viewer extension for Microsoft Edge and Chromium browsers. It is built to work entirely on your device.

## What Nivra does with your documents

- PDFs are opened, rendered and recolored **locally in your browser**. They are never uploaded to Nivra or to any server run by the developer.
- When you open a PDF from a web address, your browser downloads it from that website exactly as it would without Nivra (using your normal cookies for that site, so PDFs behind a login still open).
- PDFs you choose or drop in the Nivra popup are held temporarily in your browser's local storage so the viewer tab can open them, then removed. Anything left behind is deleted within a day.
- Downloaded or printed "transformed" copies are generated on your device.

## What Nivra stores

Nivra saves a few settings in your browser (`chrome.storage.local`): whether Nivra is turned on, your display mode, brightness, contrast, zoom, sidebar and toolbar state, and — if you tick "Remember for this site" — the appearance chosen for that website's hostname. This data stays on your device. It is not synced or transmitted. Removing the extension deletes it.

## What Nivra does not do

- No accounts, analytics, telemetry, advertising or tracking.
- No data is sold, shared or sent to third parties.
- No remote code is loaded; everything Nivra runs ships inside the extension package.

## Permissions

| Permission | Why |
|---|---|
| `declarativeNetRequest` / `declarativeNetRequestWithHostAccess` | Redirect navigations to PDF files into Nivra's viewer. |
| Host access to `*.pdf` URLs (web and `file://`) | Detect PDF addresses and read the PDF to display it. Nivra does not request access to other pages. |
| `storage` | Save the settings listed above. |
| `activeTab` | Let the toolbar popup see whether the current tab is a PDF so it can offer "Open in Nivra". |

## Contact

Questions about this policy: support@bhyresh.me
