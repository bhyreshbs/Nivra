# Nivra

**Make documents easier on your eyes.**

Nivra is a local-first browser extension (Microsoft Edge, Chrome and other Chromium browsers) that replaces the standard PDF viewing experience with a real-time visual transformation layer — Smart Dark, True Invert, Grayscale, High Contrast, Brightness, and Contrast — without ever modifying the original file.

> Open. Transform. Read.
> No upload. No conversion. No modification.

**Highlights (v1.6)**

- Smart Dark that keeps photos, charts and diagrams in their real colours (pages *and* sidebar thumbnails)
- Profiles (Reading, Night, Study, Focus, Original) and a "Remember for this site" look per website
- Settings that persist: mode, brightness, contrast, zoom, sidebar, two-page view, toolbar state
- Page thumbnails, outline (bookmarks), search, zoom / fit page / fit width, two-page view, rotate, document properties
- Print and download a transformed copy; open any local PDF by dropping it on the toolbar popup
- A collapsible bottom bar whose button shows the active mode, with an animated letter-by-letter swap
- Lighter visuals automatically on low-end hardware

---

## Table of Contents

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
- Local file support requires the user to manually enable **"Allow access to file URLs"** for the extension in `chrome://extensions` — this can't be granted programmatically and should be called out in onboarding.
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
├── manifest.json
├── _locales/en/          # Store name + description (messages.json)
├── background/           # MV3 service worker: PDF interception (declarativeNetRequest)
├── popup/                # Toolbar popup: on/off, open-a-PDF drop zone, shortcuts
├── viewer/               # PDF viewer UI: viewer.html / viewer.js / glass.css / input.css
├── pdfjs/                # PDF.js build, fonts, cmaps, WASM decoders (copied by build.js)
├── transformations/      # Visual engine, Smart Dark (smart-dark/), print/export renderer
├── settings/             # Preferences, profiles, per-site looks, popup→viewer file hand-off
├── tests/                # node --test unit tests
├── docs/                 # privacy.html (published with GitHub Pages)
├── assets/               # Icons and logo
├── logo.html             # Logo sheet + promo tile draft (not shipped)
├── build.js / package.js # Build dependencies / create the store zip
├── PRIVACY.md  STORE_LISTING.md  LICENSE
```

## Getting Started

```bash
git clone https://github.com/bhyreshbs/Nivra
cd Nivra
npm install
npm run build        # Tailwind CSS + copy PDF.js, fonts and decoders
npm test             # unit tests
npm run package      # creates dist/ and nivra-<version>.zip for the store
```

Then load it:

1. Go to `edge://extensions` (or `chrome://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `dist/` folder (created by `npm run package`)

To open PDFs saved on your computer by double-clicking, also enable **"Allow access to file URLs"** on the extension's card. Without it you can still open a local PDF by dropping it on the Nivra popup.

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

v1.6.0 — PDF viewer, all display modes, Smart Dark, profiles, per-site looks, outline, local-file picker, print and transformed download. Packaged for the Microsoft Edge Add-ons store (see `STORE_LISTING.md`; privacy policy in `PRIVACY.md`).

## License

MIT — see `LICENSE`. Bundled PDF.js is Apache-2.0 and Inter is SIL OFL 1.1; both keep their own licenses inside the package.
