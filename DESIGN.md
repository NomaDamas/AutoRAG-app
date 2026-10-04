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


### Global appearance
The persisted `AppSettings.appearance` value is the only appearance control and
accepts `light` or `dark`. The main process applies it through Electron's
`nativeTheme.themeSource` before creating the Finder and pre-warmed Quick Look
windows, and each preload mirrors it into `data-appearance` before the first
paint. Both renderers therefore use the same appearance; Quick Look has no
separate theme setting. Switching Appearance in Settings updates Finder,
Settings, AI surfaces, and an already-open Quick Look window without reloading
its file. The default is light and the choice survives restart.
---

## 1. Atmosphere & Design Principles

### 1.1 "macOS Finder That Thinks"
The application is not an isolated AI chatbot; it is a **living macOS Finder browser enhanced with continuous grounded AI assistance**.
- **Material & Surfaces:** Soft translucent sidebar with backdrop blur (`blur(18px)`), crisp white canvas, clean 1px hairline dividers (`--border: #E3E3EA` / `#D9DADD`).
- **Restraint & Typography:** Bold type is strictly reserved for primary titles and top-level section headers (`font-weight: 600`). All setting item labels, descriptions, and list rows maintain comfortable regular weights (`font-weight: 400` / `500`).
- **Permanent Multi-Pane Architecture:** 
  - Left navigation (Sidebar) provides collapsible place groups (`Favorites`, `Cloud`).
  - Center area hosts Finder tab browsing and bottom AI Search dock.
  - Right panel (Info / Evidence) is **permanently present**, preventing jarring layout shifts during file inspection.

### 1.2 Path bar
The path bar under the Finder list is one line at every window size and never shows an ellipsis. When the trail does not fit, labels give up space in a fixed order — middle segments left to right (`Users`, the home folder, …), then the root (`Macintosh HD`), then the parent of the current location, then the current location or selected file. A label first narrows with its last `--fade-label` (14px) faded out, so the word reads as cut off; once fewer than 32px would remain, the segment shows only its icon. If even the icon-only trail is too wide, it stays pinned to its end and fades in from the leading edge. Logic: `src/renderer/src/state/path-fit.ts`; visual check: `scripts/manual-qa/run-qa-finder-path-bar.mjs`.
### 1.3 Finder list density
The list view follows the Bloom Finder density contract: file rows are 24px high, names and metadata use 12px text, default file names use the primary near-black ink, and alternate rows use `#F4F5F5`. A focused selection fills the complete row with the accent color immediately, with no background-color transition and no visible corner rounding; an unfocused selection remains muted gray. Virtualized row geometry and keyboard reveal scrolling use the same 24px stride. The top Finder chrome uses larger 32px controls with 18px glyphs so navigation, sorting, view mode, and folder actions remain easy to target.


### 1.4 Info panel metadata
Selecting an entry reads its rich metadata on demand through `fs:details` (`FsFileDetails`): kind, size, where, absolute path, creation/modified/accessed/change times, symlink target, permission string, owner, group, and inode; image files additionally carry an EXIF block (`FsImageMetadata`) read by `src/main/image-metadata.ts` (exifr) — dimensions, make, model, lens, ISO, aperture, shutter, focal length, capture time, and more. The panel body scrolls, so a photo's full tag list never stretches the column.

The list is expanded by default and the "간략히 / 전체 정보" button collapses it to the core summary (kind, size, where, path, created, modified); the button only appears when there is a non-core row to hide. Labels, ordering, and the collapse rule live in `src/renderer/src/state/inspector-info.ts`; automated check: `test/ui-inspector-info.test.ts`; on-device check: `scripts/manual-qa/run-qa-finder-info-metadata.mjs`.

---

## 2. Keyboard Shortcuts

| Shortcut | Scope | Behavior |
|---|---|---|
| `⌘,` | Global | Open or focus Settings tab |
| `⌘T` | Window | Open new Finder tab |
| `⌘W` | Window | Close current Finder tab |
| `⌘F` | Window | Focus Instant Search bar |
| `⌘K` | Window | Toggle and focus AI Search composer |
| `Space` | File List | Quick Look preview of the selected file or folder (`src/preview/DESIGN.md`) |
| `⌥ Space` | Global | Global AutoRAG Spotlight summon |
| `Enter` | Search Bar | Commit search with Filenames |
| `⌥ Enter` | Search Bar | Commit search with Content |
| `Escape` | Window | Dismiss dropdowns, clear active search focus |

---

## 3. Inspector file actions

The Info half's bottom bar is data-driven, not a fixed four buttons.

- **Which actions** a file offers comes from `src/renderer/src/state/file-actions.ts`:
  the base set is 열기 · 다른 앱으로 열기 · 압축 · 공유 · AI 요약, plus 압축 해제
  for `.zip`, an 이미지 편집 menu for images, and a 동영상 변환 menu for video.
  Quick Look, 경로 복사, and 휴지통 are deliberately absent — Space, the row
  context menu, ⌘⌫, and the Info chips already cover them.
- **Whether an action is real** comes from `actions:capabilities` in main: the
  macOS share sheet, the image engine (`sips`, plus WebP through `ffmpeg`), and
  video container conversion (`ffmpeg`) are probed once per session. A missing
  engine removes the button instead of failing on click.
- **Adding an action** is two edits: one entry in `suggestedActions` (label,
  icon, and the `ActionRequest` it runs) and one `case` in
  `createActionService.run` (`src/main/action-service.ts`). The bar, the menu,
  the IPC channels, and the capability gating need no change.
- Action outputs never overwrite: `uniqueChild` numbers them Finder-style
  (`photo.jpeg`, `photo 2.jpeg`), and extraction strips a wrapper folder that
  matches the archive name so `docs.zip` restores `docs/`'s contents directly.

---

## 4. Verification & Testing Guardrails

- All UI components and behaviors are backed by automated tests:
  - Unit & contract tests via Vitest (`bun run test`).
  - Strict TypeScript validation (`bun run typecheck`).
  - Headless browser automation via Playwright verifying actual DOM bounding boxes, focus preservation, and animation lifecycle transitions.
