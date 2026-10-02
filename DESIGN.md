# AI Finder v7 Design System

Implementation contract and design specification for the **AutoRAG Agent — AI Finder** desktop app (Electron + React + TypeScript, hand-written CSS, macOS Native Finder fidelity).

---

## Reference Contract & Foundations

The design strictly reproduces the **v7 Bloom macOS Native Finder** philosophy. Nothing is reinterpreted or approximated.

| Resource | Path / Pointer |
|---|---|
| **Design Reference** | `docs/design-reference/ai-finder/design_handoff_ai_finder_v7_bloom/AI Finder v7.html` |
| **Tokens & Theming** | `src/renderer/styles/tokens.css` (Surfaces, Typography, Radii, Shadows, Accents) |
| **Component Styles** | `src/renderer/styles/shell.css`, `src/renderer/styles/finder.css`, `src/renderer/styles/sidebar.css` |

---

## 1. Atmosphere & Design Principles

### 1.1 "macOS Finder That Thinks"
The application is not an isolated AI chatbot; it is a **living macOS Finder browser enhanced with continuous grounded AI assistance**.
- **Material & Surfaces:** Soft translucent sidebar with backdrop blur (`blur(18px)`), crisp white canvas, clean 1px hairline dividers (`--border: #E3E3EA` / `#D9DADD`).
- **Restraint & Typography:** Bold type is strictly reserved for primary titles and top-level section headers (`font-weight: 600`). All setting item labels, descriptions, and list rows maintain comfortable regular weights (`font-weight: 400` / `500`).
- **Permanent Two-Column Architecture:** 
  - Left navigation (Sidebar) provides collapsible place groups (`Favorites`, `Cloud`).
  - Center area hosts Finder tab browsing and bottom AI Search dock.
  - Right panel (Info / Evidence) is **permanently present**, preventing jarring layout shifts during file inspection.

---

## 2. Core UI/UX Specifications

### 2.1 Tab-Based Settings Architecture (No Modal Popups)
- **Settings as a First-Class Tab:**
  - Invoked via sidebar bottom button or global shortcut (`⌘,`).
  - Opens as a dedicated Finder tab or focuses existing Settings tab with complete tab management (`⌘W` to close, tab switching, and history navigation).
- **Two-Column Linear-Inspired Configuration:**
  - **Left Category Navigation:** `General`, `Models`, `Data Sources`, `Contacts` with subtle gray hover and rounded pill highlights.
  - **Right Configuration Canvas:** Borderless, clean grouped rows without heavy boxed cards. Each row contains setting name (`14px`), single-line auxiliary description (`12.5px`, muted), and right-aligned controls (switches, dropdown selects, and action buttons).
- **LLM Models Configuration:**
  - Flagship 2026 model generation lineup: OpenAI (`GPT-6.1 Sol`, `GPT-6.1 Astra`), Anthropic (`Opus 5.5`, `Sonnet 5.5`), xAI (`Grok 4.7`), Google Gemini (`Gemini 3.8 Flash`), Cursor Composer (`Composer 2.5`).
  - **Custom OpenAI-Compatible Provider:** Expandable inline configuration card for custom Base URL, Model ID, and API Key (supporting vLLM, SGLang, LiteLLM, Ollama).
- **Data Sources Integration:**
  - Modular integration listing for cloud drives and workspaces. Connected status indicator (`Connected` vs `Not connected`).

### 2.2 Top-Left Window Chrome & Adaptive Toolbar
- **Sidebar Open State:**
  - Sidebar header hosts traffic lights (`🔴 🟡 🟢`) on the left, and aligns **Sidebar Toggle (`[|]`)** and **New Folder (`[folder+]`)** to the right edge before the vertical separator.
  - Main toolbar seamlessly begins with Back (`<`), Forward (`>`), and current folder title.
- **Sidebar Collapsed State:**
  - When the sidebar is collapsed, the traffic lights (`🔴 🟡 🟢`), **Sidebar Toggle (`[|]`)**, and **New Folder (`[folder+]`)** dynamically migrate to the leading position of the main toolbar.
  - Result: `[Traffic Lights] [Sidebar Toggle] [New Folder] [<] [>] [Title] ...` forming an uninterrupted macOS header.

### 2.3 Instant Search & Native Scope Bar
- **Composed Search Input:**
  - Typing does not trigger premature re-renders or steal text input focus; keystrokes accumulate into `searchDraft`.
  - Pressing `Enter` or clicking an option commits the query.
- **Spotlight-Style Dropdown:**
  - Suggests targeted filters:
    - **Filenames:** `Name Contains "<query>"` (`↵ Enter`)
    - **Content:** `Contains "<query>"` (`⌥↵ Option+Enter`)
  - Includes quick clear button (`✕`).
- **macOS Scope Bar:**
  - Appears seamlessly below the toolbar with transparent background matching the browser view.
  - Clean pill toggle between **`This Mac`** (full indexing) and **`"<Current Folder>"`** (focused scope). Selected target is highlighted with a soft gray rounded pill (`#e3e3e7`), while unselected options remain transparent text.

### 2.4 AI Search Dock, Streaming & Evidence Inspection
- **Raycast-Style Clean Stream:**
  - User messages are enclosed in soft gray bubbles (`#eef0f3`).
  - Assistant answers flow as **borderless, unboxed natural prose directly on the canvas**.
  - **Referenced File Badges:** When files are dragged & dropped or attached, they render above the user bubble in matching tone & manner chips.
- **Progressive Answer Streaming with Water-Wave Shimmer:**
  - **Quick Answer:** Appears immediately with preliminary citations.
  - **Thinking Shimmer:** While Deep Answer is deliberating, an animated water-wave text (`Thinking... Searching relevant sources & cross-checking figures`) streams left-to-right beneath the quick response.
  - **Deep Answer:** Thinking finishes and collapses into a collapsible summary header (`Worked for 38s >`), rendering the complete analytical synthesis.
- **Adjacent Citation Spacing:**
  - Multiple sequential citation buttons (`.cite + .cite`) maintain exact `margin-left: 3px` spacing to preserve typographical rhythm.
- **50:50 Split Inspector (Info & Evidence):**
  - Clicking an evidence citation divides the right panel equally:
    - **Top 50% (Info):** File preview, metadata, tags, and **action bar (Quick Look, Copy Path, AI Summary, Trash) permanently preserved**. Header provides a native **Share button (`[↑]`)**.
    - **Bottom 50% (Evidence):** Citation tab numbers, excerpt blockquotes, source paths, and icon-only **Thumbs Up (`👍`) / Thumbs Down (`👎`)** feedback buttons.
    - Closing Evidence restores Info panel to full 100% height.

---

## 3. Keyboard Shortcuts

| Shortcut | Scope | Behavior |
|---|---|---|
| `⌘,` | Global | Open or focus Settings tab |
| `⌘T` | Window | Open new Finder tab |
| `⌘W` | Window | Close current Finder tab |
| `⌘F` | Window | Focus Instant Search bar |
| `⌘K` | Window | Toggle and focus AI Search composer |
| `Space` | File List | Native Quick Look preview |
| `⌥ Space` | Global | Global AutoRAG Spotlight summon |
| `Enter` | Search Bar | Commit search with Filenames |
| `⌥ Enter` | Search Bar | Commit search with Content |
| `Escape` | Window | Dismiss dropdowns, clear active search focus |

---

## 4. Verification & Testing Guardrails

- All UI components and behaviors are backed by automated tests:
  - Unit & contract tests via Vitest (`bun run test`).
  - Strict TypeScript validation (`bun run typecheck`).
  - Headless browser automation via Playwright verifying actual DOM bounding boxes, focus preservation, and animation lifecycle transitions.
