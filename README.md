# Nivra

**Make documents easier on your eyes.**

Nivra is a local-first Chrome extension that replaces the standard PDF viewing experience with a real-time visual transformation layer — Dark Mode, True Invert, Grayscale, High Contrast, Brightness, and Contrast — without ever modifying the original file.

> Open. Transform. Read.
> No upload. No conversion. No modification.

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
| Extension platform | Manifest V3 (Chrome; Manifest V2 is fully deprecated) |
| PDF rendering | [PDF.js](https://github.com/mozilla/pdf.js) (Apache 2.0) |
| Interception | `declarativeNetRequest` |
| Visual transforms | Canvas 2D compositing + CSS filters |
| Preferences storage | `chrome.storage.local` (no backend) |
| UI | Vanilla JS/HTML/CSS or Preact (keep bundle small); Tailwind optional for the appearance panel |
| Build | Vite or esbuild |
| Marketing site | Static site (Cloudflare Pages / Vercel / Netlify / GitHub Pages) — separate from the extension runtime |

No backend, database, or cloud infrastructure is required for core functionality — rendering happens on the user's machine.

## Project Structure

```
nivra/
├── manifest.json
├── background/          # MV3 service worker: PDF interception, routing
├── viewer/               # Nivra's PDF viewer UI (viewer.html + controller)
├── pdfjs/                # Vendored PDF.js build
├── rendering/            # Page rendering orchestration (canvas + text layer)
├── transformations/      # Visual engine: dark, invert, grayscale, contrast, smart-dark
├── settings/             # Preferences, profiles, per-site settings (chrome.storage)
├── export/                # (Phase 6) transformed-PDF export
├── assets/               # Icons, static assets
└── docs/                  # Architecture notes, ADRs
```

## Getting Started

Local development requires no Chrome Web Store publication.

```bash
git clone <this-repo>
cd nivra
npm install
npm run build        # bundles into /dist
```

Then load it into Chrome:

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `dist/` (or project) folder

To test local-file PDFs, also enable **"Allow access to file URLs"** on the extension's card in `chrome://extensions`.

### First milestone (proof of concept)

Before building the full viewer, prove the core loop end-to-end:

> Open an online or local PDF → render it through Nivra via PDF.js → apply True Invert on canvas in real time.

Once that's reliable, expand outward per the roadmap below.

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

V1 for initial shipping = Phases 1–3 (+ a minimal slice of 5 for usability). Everything past that is explicitly post-V1.

## Visual Modes

| Mode | Behavior |
|---|---|
| **Original** | No transformation (default fallback) |
| **Smart Dark** *(flagship, Phase 4)* | Dark background / light text while preserving photos, charts, diagrams, logos |
| **Dark Mode** | White→dark background, black→light text; simpler than Smart Dark, still content-aware where feasible |
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
   preserved via an overlay canvas inside `.canvasWrapper` carrying the exact
   inverse filter chain (including brightness/contrast sliders), so
   `F(F⁻¹(pixels)) ≈ original`. Document-like images (white-background
   letterhead scans, watermarks) invert with the page instead of becoming
   glaring white boxes.
5. **Layer safety**: the filter only ever touches `.canvasWrapper` — the text
   layer (selection/search), annotation layer (links/forms) and the Nivra UI
   are never transformed, and nothing is transformed twice.

Developer flags (never shown in production UI):

- `?nivraDebug=1` (or `localStorage['nivra.debug'] = '1'`) — analysis overlay:
  background wash, image boxes (red = preserved, orange = inverted),
  text regions, per-page stats badge.
- `localStorage['nivra.smartDark.preserveImages'] = 'false'` — disables image
  preservation (images invert with the page).

Printing and "Download Original" default to the untransformed PDF so users don't accidentally waste ink printing a dark page.

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

This repo is in early build-out (Phase 1–2). Suggested first issues:

- [ ] MV3 manifest + service worker skeleton
- [ ] `declarativeNetRequest` rule to redirect PDF navigation to `viewer.html`
- [ ] Minimal `viewer.html` wired to PDF.js (single page render)
- [ ] Canvas-level True Invert toggle
- [ ] `chrome.storage.local` preferences scaffold

Please open an issue before starting on Phase 4 (Smart Dark) work — it needs a design discussion (content-stream parsing vs. pixel heuristics) before implementation.

## Status

🚧 Pre-V1 / Phase 1 (Proof of Concept). Not yet published to the Chrome Web Store.

## License

TBD — add a LICENSE file before accepting external contributions. Note: PDF.js itself is Apache 2.0; any vendored copy must retain its license and attribution.
