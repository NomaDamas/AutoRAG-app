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
  - Left navigation (Sidebar) lists the live OS places in three groups (`Favorites`, `Cloud`, `Locations`), with **AI Search** above Recents; see §1.5.
  - Center area hosts the tab strip. A tab shows a folder, Settings, or the AI Search chat — AI Search is a tab, not a bottom dock.
  - Right panel (Info / Evidence) is **permanently present**, preventing jarring layout shifts during file inspection.


### 1.2 Sort and grouping controls
The Finder toolbar exposes Sort and Group pop-up controls beside the view-mode
segmented control. Sort writes the shared `SortState` used by list column headers
and applies in icon, list, column, and search layouts. Grouping is visual only:
`state/grouping.ts` splits the same rows into section headers without creating
folders or changing entry identity; the virtualized list and icon views account
for header height in their window geometry, and column panes render the same
sections inline. Native Finder criteria are populated during filesystem
enrichment: creation time comes from the real filesystem birth time, tags and
comments use Finder extended attributes with Spotlight fallback, dimensions use
the image reader, Date Added / Date Last Opened / rating use Spotlight, and
Application uses Launch Services' default opener. Unknown values remain unknown;
they are never replaced with modification time or an unrelated application.
Pure behavior is covered by `test/ui-sort.test.ts` and `test/ui-grouping.test.ts`.
### 1.3 Path bar
The path bar under the Finder list is one line at every window size and never shows an ellipsis. When the trail does not fit, labels give up space in a fixed order — middle segments left to right (`Users`, the home folder, …), then the root (`Macintosh HD`), then the parent of the current location, then the current location or selected file. A label first narrows with its last `--fade-label` (14px) faded out, so the word reads as cut off; once fewer than 32px would remain, the segment shows only its icon. If even the icon-only trail is too wide, it stays pinned to its end and fades in from the leading edge. Logic: `src/renderer/src/state/path-fit.ts`; visual check: `scripts/manual-qa/run-qa-finder-path-bar.mjs`.
### 1.3 Finder list density
The list view follows the Bloom Finder density contract: file rows are 24px high, names and metadata use 12px text, default file names use the primary near-black ink, and alternate rows use `#F4F5F5`. A focused selection fills the complete row with the accent color immediately, with no background-color transition and no visible corner rounding; an unfocused selection remains muted gray. Virtualized row geometry and keyboard reveal scrolling use the same 24px stride. The top Finder chrome uses larger 32px controls with 18px glyphs so navigation, sorting, view mode, and folder actions remain easy to target.
Fresh windows start with the sidebar at its minimum 180px width and the inspector at its minimum 300px width; user-resized values remain persisted.

### 1.3a AI Search tabs
AI Search is a tab view like Settings (`AI_SEARCH_PATH`, `src/renderer/src/state/tabs.ts`). Each AI Search tab owns its chat; the panel stays mounted while its tab is in the background or browses a folder, and unmounts when the tab closes. Entry points:
- **Sidebar → Favorites → AI Search**: the *focused* tab becomes AI Search (a navigation, so Back returns to the folder).
- **`⌘K`** and the toolbar sparkles: the nearest open AI Search tab, else a new one; the composer is focused.
- **Inspector "AI 요약"** and the sidebar search's **내용** chip: always a *new* AI Search tab, with the file attached or the query sent.
- **Drops**: Finder rows, OS files, and links attach when dropped on the AI Search panel, on an AI Search strip tab (it switches to that tab; dwelling springs it open), or on the sidebar AI Search item (the focused tab becomes AI Search). A Finder row dropped on an AI Search tab is attached, never moved.

A Settings or AI Search tab lists no rows: ⌘T opens a folder tab on the last folder it showed, and a filename search returns the tab to that folder. Pure behavior: `test/ui-tabs.test.ts`; on-device check: `scripts/manual-qa/run-qa-finder-ai-search-tab.mjs`.

The inspector follows the focused tab and shows one full-height view: a folder tab shows **Info** for its selection, and an AI Search tab shows **Evidence** — the cited sources of that tab's answer, numbered, with feedback and excerpts. A citation chip selects its source. A source title acts by kind: a local file opens its folder in a new tab with the file selected, a datasource id (`/kakao/…`) is plain text, and an `http(s)` page opens in the OS default browser through `fs:openUrl` (`shell.openExternal`). Main re-checks the scheme with the shared `webUrl`, so `file:` and custom schemes are refused. On-device check: `scripts/manual-qa/run-qa-finder-evidence-panel.mjs`.

**Images in answers and evidence.** `parseInline` (`src/renderer/src/state/answer-markdown.ts`) reads three spellings as image references: a markdown image `![alt](ref)` (plain or `<ref>` form), inline code holding an absolute image path or URL, and a bare absolute image path in a sentence (it ends at the extension, so a Korean particle or a final period stays text). A markdown image renders only as the picture; a path the model wrote in a sentence stays as text, and its picture appears under the line. `imageTarget` resolves each reference, and `components/AnswerImage.tsx` renders it:
- **Local, drawable** (`viewerForExtension` = `image`): the picture streams through `autorag-preview://`, the same protocol Quick Look uses (`img-src` already allows it). In answer prose it has no caption, since the Evidence panel already names each source, and the full path shows on hover. In evidence excerpts it is captioned with the file name. Clicking it opens Quick Look.
- **Local, not drawable** (HEIC, TIFF): a card with the name and path. Clicking it opens Quick Look, which converts the file.
- **Missing or unreadable**: when `<img>` errors, a card with the name, the path, and "이미지를 불러올 수 없습니다". No broken image.
- **Web image**: never fetched from model output. A card shows the URL and opens the page in the OS browser through the same `webUrl`-checked path as a web source.
- **Relative link**: in an evidence excerpt it resolves against the cited file's folder (`resolveRelative`); in an answer there is no document to resolve against, so the card shows the link as written.

An image evidence source shows the picture itself in the Evidence paper. Pure behavior: `test/ui-answer-markdown.test.ts`; on-device check: `scripts/manual-qa/run-qa-finder-ai-search-images.mjs`.

### 1.4 Info panel metadata
Selecting an entry reads its rich metadata on demand through `fs:details` (`FsFileDetails`): kind, size, where, absolute path, creation/modified/accessed/change times, symlink target, permission string, owner, group, and inode; image files additionally carry an EXIF block (`FsImageMetadata`) read by `src/main/image-metadata.ts` (exifr) — dimensions, make, model, lens, ISO, aperture, shutter, focal length, capture time, and more. The panel body scrolls, so a photo's full tag list never stretches the column.

The preview paper above the metadata shows the file's real content, not a type icon: `fs:previewIcon` renders a 640px Quick Look thumbnail in the main process (same bounded pool, single-flight map, and LRU cache as the 128px listing tier, keyed `(path, mtime, size)` and served through the `autorag-thumb://` protocol's optional `size` parameter; generation runs on its own two-permit lane so a slow listing batch never makes the panel wait). There is no fixed frame: the image takes the panel's full width and its own aspect ratio sets the height (capped at 70vh), so a portrait PDF fills the column instead of letterboxing. The paper is that frame from the very first paint — while the tier loads it is a blank sheet at the last known aspect, then the content fades in and the aspect-ratio transition settles the height, so nothing ever snaps. A process-local `(path, mtime) → preview + aspect` cache means re-selecting a file renders the final layout within a frame or two, with no repeat IPC. The compact bordered box (listing icon or letter tile) only appears for folders and files the OS provably has no preview for.

Scrollbars are deliberately unstyled (base.css §7): any `::-webkit-scrollbar` rule forces Chromium's classic scrollbars, which consume layout width and visibly shift the preview and metadata rows whenever the panel starts or stops scrolling. Leaving them untouched keeps the macOS-native overlay scrollbars that float above the content, so no surface ever changes width; on-device check: `scripts/manual-qa/run-qa-finder-overlay-scrollbars.mjs`.

A multi-selection replaces the single-file panel with the aggregate view (`src/renderer/src/state/inspector-multi.ts`): a fan of up to five of the selection's own preview papers, each sheet dog-eared (`.page-curl`) and drop-shadowed, deeper sheets rotated wider and stepped further out, focused file in front; then the "N개 항목" title, the per-kind breakdown with the total size ("PDF document 2개 · 1 KB", tails folded into 외 N종), and 생성한/수정한 날짜 date ranges that collapse to one date on a shared day. Per-file affordances — the index chip, the Versions family, the action bar — stay single-selection only. On-device check: `scripts/manual-qa/run-qa-finder-inspector-preview.mjs`.

The list is expanded by default and the "간략히 / 전체 정보" button collapses it to the core summary (kind, size, where, path, created, modified); the button only appears when there is a non-core row to hide. Labels, ordering, and the collapse rule live in `src/renderer/src/state/inspector-info.ts`; automated check: `test/ui-inspector-info.test.ts`; on-device check: `scripts/manual-qa/run-qa-finder-info-metadata.mjs`.

### 1.5 Sidebar places
Every sidebar row comes from the OS, through `fs:locations` (`src/main/places.ts`); nothing is a fixed provider or drive list, and a group with no rows is not rendered.
- **Favorites** — the **AI Search** app row (§1.3a), then Recents, then Finder's standard places: the home folder, Applications, Desktop, Documents, Downloads, Music, Movies, Pictures, Trash (`~/.Trash`). On Windows the same slots use Explorer's names and the real known-folder paths (OneDrive folder redirection honored), Program Files, and the user's `$Recycle.Bin\<SID>`, whose `$R` payloads are listed under their original names (`src/main/recycle-bin.ts`). A missing folder stays in its slot, dimmed.
- **Cloud** — exactly the drives connected to the OS, one row per account: iCloud Drive plus every `~/Library/CloudStorage/<Provider>-<account>` File Provider domain on macOS (e.g. `Google Drive - me@example.com`, `OneDrive - Personal`); the `SyncRootManager` roots registered for the user's SID and a Google Drive virtual drive letter on Windows.
- **Locations** — the boot disk (`/`, or the system drive) plus every browsable mounted volume: `/Volumes/*` mount points without `nobrowse`, or every other drive letter. Each carries an eject button flush right; ejecting moves tabs out of the volume first (so no watcher holds it), then runs `diskutil unmount` (macOS), `net use X: /delete` for network drives, or the shell Eject verb (Windows). A refusal surfaces verbatim in the toast.

The main process polls a cheap mount signature (volume names and device ids, cloud domains) every 2s and pushes `fs:locationsChanged`, so a volume or cloud account that comes or goes updates the sidebar without a restart. Search and the dupey scan walk only `scanned` places (Desktop, Documents, Downloads, cloud drives) — never the home folder or a whole disk. Rows are 28px with 12px labels and 14px glyphs. Automated checks: `test/places.test.ts`, `test/ui-places.test.ts`; on-device check (attaches and ejects a real disk image): `scripts/manual-qa/run-qa-finder-sidebar-places.mjs`.

---

## 2. Keyboard Shortcuts

| Shortcut | Scope | Behavior |
|---|---|---|
| `⌘,` | Global | Open or focus Settings tab |
| `⌘T` | Window | Open new Finder tab |
| `⌘W` | Window | Close current Finder tab |
| `⌘F` | Window | Focus Instant Search bar |
| `⌘K` | Window | Show the nearest AI Search tab (or open one) and focus its composer |
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
