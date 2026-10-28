# Nivra

**Make documents easier on your eyes.**

Nivra is a local-first browser extension (Microsoft Edge, Chrome, Opera and other Chromium browsers, plus a Firefox build) that replaces the standard PDF viewing experience with a real-time visual transformation layer — Smart Dark, True Invert, Grayscale, High Contrast, Brightness, and Contrast — without ever modifying the original file.

> Open. Transform. Read.
> No upload. No conversion. No modification.

## Install

| Browser | Status | Link |
|---|---|---|
| Microsoft Edge | Available | [Get Nivra on Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/kecobckfpgekkaempmadljlmfplkbalp) |
| Google Chrome | Coming soon | — |
| Brave | Coming soon | — |
| Opera | Coming soon | — |
| Firefox | Coming soon | — |

After installing, turn on **Allow access to file URLs** for Nivra on your browser's extensions page to open PDFs saved on your computer. A welcome page walks you through it.

**Firefox:** allow Nivra's site access when the popup asks (or in `about:addons` → Nivra → Permissions) so PDF links open in Nivra. Firefox does not let add-ons open files from your computer, so local PDFs (`file://`) stay in Firefox's own viewer; to read one in Nivra, drop it on the Nivra popup.

**Highlights (v1.7.0)**

- Automatic PDF redirection on Microsoft Edge, Chrome and Opera, for web `.pdf` links and local `file://` PDFs, with a fallback for when Edge's or Opera's own viewer wins the race
- A Firefox build that redirects web `.pdf` links (local files stay in Firefox's viewer; drop them on the popup instead)
- A popup banner that tells you when "Allow access to file URLs" is off, and browser-aware wording (Edge, Chrome, Opera or Firefox); on Firefox it asks for site access instead
- A welcome page on first install and a goodbye page on uninstall (static pages in `docs/`, served by GitHub Pages)
- Smart Dark that keeps photos, charts and diagrams in their real colours (pages *and* sidebar thumbnails)
- Profiles (Reading, Night, Study, Focus, Original) and a "Remember for this site" look per website
- Settings that persist: mode, brightness, contrast, zoom, sidebar, two-page view, toolbar state
- Page thumbnails, outline (bookmarks), search, zoom / fit page / fit width, two-page view, rotate, document properties
- Print and download a transformed copy; open any local PDF by dropping it on the toolbar popup
- A collapsible bottom bar whose button shows the active mode, with an animated letter-by-letter swap
- Lighter visuals automatically on low-end hardware

---

## Table of Contents

- [Install](#install)
- [What Nivra Is](#what-nivra-is)
- [What Nivra Is Not](#what-nivra-is-not)
- [Core Principles](#core-principles)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Development Roadmap](#development-roadmap)
- [Visual Modes](#visual-modes)
- [Privacy](#privacy)
- [Contributing](#contributing)
- [Status](#status)
- [License](#license)

---

## What Nivra Is

Nivra is a browser-based document viewing and visual transformation layer. A user opens a PDF normally (from a URL or a local file); Nivra intercepts it, renders it locally via PDF.js, and lets the user change how it looks — instantly, entirely on-device, without altering the source file.

**Consumer promise:** Make documents easier on your eyes.
**Technical positioning:** A local-first browser rendering layer that transforms the visual appearance of digital documents in real time while preserving the original document.
**Privacy positioning:** Your documents stay on your device.

Long-term, Nivra is meant to become a **universal visual layer for digital documents** — starting with PDF, later expanding to Google Docs, Google Slides, PowerPoint Web, EPUB, and images — via a core engine + document-specific adapters (see [Architecture](#architecture)).

## What Nivra Is Not

To keep scope honest, Nivra deliberately excludes (at least for V1 and the near-term roadmap):

- PDF editor / merger / splitter / compressor / converter
- PDF signing or AI chatbot features
- Cloud document storage
- Any workflow that requires uploading a document to a server for normal viewing

## Core Principles

1. **Never modify the original file.** Nivra is a viewer, not an editor.
2. **Local-first.** All rendering and transformation happens in the user's browser. No PDF processing server.
3. **No account required.** Install and use immediately.
4. **Instant.** No upload → process → download cycle. Changing visual mode is a synchronous, immediate visual change.
5. **Preserve document functionality.** Text stays selectable/searchable, links stay clickable, printing/download default to the original appearance.

## Architecture

Nivra is built around three separated concerns so the PDF-only V1 can grow into a multi-format product without a rewrite:

```
                    NIVRA CORE
                       │
          ┌────────────┼────────────┐
          ↓            ↓            ↓
       PDF Adapter   Docs Adapter   Slides Adapter
          │            │            │
        PDF.js        DOM          Canvas/DOM
          │            │            │
          └────────────┼────────────┘
                       ↓
              Nivra Visual Engine
                       ↓
                Nivra Experience
```

- **Nivra Core** — appearance modes, profiles, settings, shortcuts, preferences, UI shell.
- **Adapters** — one per document platform (PDF first; Docs/Slides/PowerPoint/EPUB later). Each adapter knows how to get a renderable page out of its platform.
- **Visual Engine** — takes a rendered page (canvas/DOM) and applies the selected transformation (Dark, Invert, Grayscale, High Contrast, Brightness, Contrast, Smart Dark).

### PDF rendering pipeline (V1)

```
PDF (online or local)
        ↓
   Nivra Extension
        ↓
   PDF Handler (declarativeNetRequest redirect → viewer.html)
        ↓
       PDF.js
        ↓
  Canvas + Text Layer
        ↓
  Nivra Visual Engine
        ↓
    Nivra Viewer UI
```

Key implementation notes:

- Chrome's native PDF viewer is intercepted via a `declarativeNetRequest` rule that redirects PDF navigations to Nivra's own `viewer.html?file=<url>`, the same general approach used by existing PDF.js-based Chrome extensions.
- On Microsoft Edge and Opera, where the built-in viewer can win the race against the redirect rule, a `tabs.onUpdated` fallback (gated to Edge and Opera, no extra permission) redirects any tab still showing a `.pdf` URL. The Chrome path is unchanged. Opera uses the same code as Edge and Chrome, packaged by `package-opera.js`: the Opera store rejects PDF.js's `.pfb`/`.bcmap`/`.icc` files, so its zip stores the fonts and CMaps as base64 text (decoded by `viewer/binary-data.js`) and leaves out the ICC profile.
- Local file support requires the user to manually enable **"Allow access to file URLs"** for the extension in `edge://extensions`, `opera://extensions` or `chrome://extensions` — this can't be granted programmatically. The popup shows a banner when it is off, and the welcome page explains it.
- Firefox has its own build (`npm run package:firefox`, `manifest.firefox.json`, `background/sw.firefox.js`): a blocking `webRequest.onBeforeRequest` listener redirects web PDF navigations. `webRequest` never fires for `file://` and extension pages cannot read `file://` URLs there, so local PDFs are left to Firefox's viewer, the Firefox manifest requests no `file:///` access, and the popup points to drag-and-drop instead of offering "Open in Nivra" on a local tab. Firefox treats MV3 host permissions as opt-in, so the popup shows site-access status and requests it with `permissions.request`.
- On first install the extension opens `docs/welcome.html`; `setUninstallURL` points at `docs/goodbye.html`. Both are hosted by GitHub Pages (`SITE_URL` in `background/sw.js`) and receive only the version and browser family.
- The PDF.js text layer is used as-is for selection/search — it's not something Nivra needs to build itself.
- "Smart Dark" (background/text vs. photo/chart differentiation) has no off-the-shelf solution; see [Development Roadmap, Phase 4](#development-roadmap) — treat this as an R&D track, not a v1 blocker.

## Tech Stack

| Layer | Choice |
|---|---|
| Extension platform | Manifest V3 (Edge / Chrome) |
| PDF rendering | [PDF.js](https://github.com/mozilla/pdf.js) (Apache 2.0) |
| Interception | `declarativeNetRequest` |
| Visual transforms | CSS filters on each page's canvas layer + a photo-restoring overlay (Smart Dark) |
| Preferences storage | `chrome.storage.local` (no backend); one-shot file hand-off via IndexedDB |
| UI | Vanilla JS / HTML / CSS, Tailwind CLI for utility classes |
| Build | `build.js` (copies PDF.js, fonts, decoders) + Tailwind CLI; `package.js` makes the store zip |
| Tests | `node --test` (`npm test`) |

No backend, database, or cloud infrastructure is required for core functionality — rendering happens on the user's machine.

## Project Structure

```
nivra/
├── manifest.json         # Chromium manifest (Edge, Chrome, Opera)
├── manifest.firefox.json # Firefox manifest (shipped as manifest.json by package-firefox.js)
├── _locales/en/          # Store name + description (messages.json)
├── background/           # PDF interception: sw.js (Chromium, declarativeNetRequest), sw.firefox.js (Firefox, webRequest)
├── popup/                # Toolbar popup: on/off, open-a-PDF drop zone, shortcuts
├── viewer/               # PDF viewer UI: viewer.html / viewer.js / glass.css / input.css
├── pdfjs/                # PDF.js build, fonts, cmaps, WASM decoders (copied by build.js)
├── transformations/      # Visual engine, Smart Dark (smart-dark/), print/export renderer
├── settings/             # Preferences, profiles, per-site looks, popup→viewer file hand-off
├── tests/                # node --test unit tests
├── docs/                 # privacy, welcome and goodbye pages (published with GitHub Pages)
├── assets/               # Icons and logo
├── logo.html             # Logo sheet + promo tile draft (not shipped)
├── build.js / package.js # Build dependencies / create the Chromium store zip
├── package-firefox.js    # Create the Firefox (AMO) zip
├── package-opera.js      # Create the Opera zip (Chromium package with encoded PDF.js data)
├── PRIVACY.md  STORE_LISTING.md  LICENSE
```

## Getting Started

```bash
git clone https://github.com/bhyreshbs/Nivra
cd Nivra
npm install
npm run build        # Tailwind CSS + copy PDF.js, fonts and decoders
npm test             # unit tests
npm run package      # creates dist/ and nivra-<version>.zip (Edge, Chrome)
npm run package:opera    # creates dist-opera/ and nivra-opera-<version>.zip (Opera: fonts/CMaps base64-encoded)
npm run package:firefox  # creates dist-firefox/ and nivra-firefox-<version>.zip (Firefox)
node tests/baseline-check.js  # confirms the Chromium package only changed where you expected
```

Then load it:

1. Go to `edge://extensions` (or `chrome://extensions`, `opera://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `dist/` folder (created by `npm run package`)

To open PDFs saved on your computer by double-clicking, also enable **"Allow access to file URLs"** on the extension's card. Without it you can still open a local PDF by dropping it on the Nivra popup.

**Firefox:** run `npm run package:firefox`, then either `npx web-ext run --source-dir dist-firefox` (opens a temporary Firefox profile with Nivra loaded), or go to `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick `dist-firefox/manifest.json`. Click the Nivra icon and choose **Allow site access**. Firefox 140 or newer is required. Check the package with `npx web-ext lint --source-dir dist-firefox` (expected: 0 errors, 4 warnings inside PDF.js).

## Development Roadmap

| Phase | Scope |
|---|---|
| **1 — Proof of Concept** | Chrome extension shell, PDF handler, PDF.js, local + online PDF, single-page render, canvas, True Invert |
| **2 — PDF Viewer** | Scrolling, page navigation, zoom, search, text selection, links, download original |
| **3 — Visual Engine** | Dark Mode, True Invert, Grayscale, High Contrast, Brightness, Contrast |
| **4 — Smart Rendering** | Image/diagram/chart preservation, content-aware transforms, Smart Dark (R&D-heavy — see architecture notes) |
| **5 — UX** | Appearance panel, profiles (Reading/Night/Study/Focus/Original), keyboard shortcuts, persistent + per-site preferences |
| **6 — Export** | Download transformed copy (Dark/Invert/Grayscale/High Contrast PDF); later, structure-preserving export |
| **7 — Multi-Platform** | Google Docs, Google Slides, PowerPoint Web, EPUB, images, other web document viewers |

**Status:** Phases 1–5 are done for PDF, plus the transformed-copy download from Phase 6. Structure-preserving export and Phase 7 (other document types) are not started.

## Visual Modes

| Mode | Behavior |
|---|---|
| **Original** | No transformation (default fallback) |
| **Smart Dark** *(flagship)* | Dark background / light text while preserving photos, charts, diagrams, logos |
| **True Invert** | Literal `R'=255-R, G'=255-G, B'=255-B` inversion |
| **Grayscale** | Full desaturation |
| **High Contrast** | Maximizes text/background/border separation |
| **Brightness / Contrast** | Real-time sliders, independent of mode |

### Smart Dark engine (implemented)

Smart Dark is a per-page, document-aware pipeline (`transformations/smart-dark/`):

1. **Render first, analyze after.** PDF.js renders at full DPR; the base filter
   `invert(100%) hue-rotate(180deg)` is applied to each page's `.canvasWrapper`
   immediately (GPU-accelerated, text/vectors stay crisp, never re-rasterized).
2. **Analysis** (async, cached per page): the operator list (`getOperatorList`)
   locates image paints with their CTM, counts text/vector ops and large fills;
   a tiny 64×64 pixel probe of the canvas measures background luminance and
   per-image composition.
3. **Page classification**: `normal` (invert + preserve photos), `dark-bg`
   (already dark — left untouched), `scanned` (one image covers ≥85% of the
   page with little text — inverted as a unit, no overlays).
4. **Image classification**: photographic images (rich mid-tones/color) are
   preserved via an overlay canvas placed *after* `.canvasWrapper` (outside the
   filter), holding the original pixels exactly — brightness/contrast never
   reach them. Document-like images (white-background letterhead scans) invert
   with the page instead of becoming glaring white boxes. An image with real
   text or vector content drawn over it inverts with the page so that content
   stays readable; diagonal text (watermarks such as "SAMPLE") and text that only
   grazes the picture's edge do not count as content over it.
   Sidebar thumbnails get the same treatment from the page's decision (or, for
   pages not yet viewed, from the thumbnail's own pixels).
5. **Layer safety**: the filter only ever touches `.canvasWrapper` — the text
   layer (selection/search), annotation layer (links/forms) and the Nivra UI
   are never transformed, and nothing is transformed twice.

Developer flags (never shown in production UI):

- `?nivraDebug=1` (or `localStorage['nivra.debug'] = '1'`) — analysis overlay:
  background wash, image boxes (red = preserved, orange = inverted),
  text regions, per-page stats badge.
- `localStorage['nivra.smartDark.preserveImages'] = 'false'` — disables image
  preservation (images invert with the page).

Print and "Download transformed PDF" use the current mode, brightness and contrast, rendered on your device. Switch to **Original** first for an ink-friendly printout.

Performance: the invert is a CSS filter on a per-page compositor layer; Smart Dark reads one small downscaled snapshot per page. On machines with ≤4 cores or ≤4 GB RAM the viewer drops backdrop blur and ambient animations (`perf-lite`).

## Privacy

```
User's PDF → User's Browser → Nivra → Local processing → User
```

Never:

```
User's PDF → Nivra server → Processing → User
```

No document is uploaded to a Nivra-controlled server for normal viewing or transformation. No login, account, or cloud sync is required for core functionality.

## Contributing

Run `npm test` for the unit tests and `npm run package` to build the store zip. Open ideas:

- [ ] Structure-preserving export (keep text selectable in a recolored copy)
- [ ] More languages (`_locales/`)
- [ ] Viewer-level automated tests

Please open an issue before changing Smart Dark — it needs a design discussion first.

## Status

v1.7.0 — PDF viewer, all display modes, Smart Dark, profiles, per-site looks, outline, local-file picker, print and transformed download, Edge and Opera PDF fallback, Firefox build, install/uninstall pages. Every browser ships the same version number. Published on the [Microsoft Edge Add-ons store](https://microsoftedge.microsoft.com/addons/detail/kecobckfpgekkaempmadljlmfplkbalp); Opera support and a Firefox build are ready for their stores; other browsers coming soon (see `STORE_LISTING.md`; privacy policy in `PRIVACY.md`).

## License

MIT — see `LICENSE`. Bundled PDF.js is Apache-2.0 and Inter is SIL OFL 1.1; both keep their own licenses inside the package.
