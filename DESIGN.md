# AutoRAG Design System (v7 Bloom)

Implementation contract and design specification for **AutoRAG** — the AI Finder
desktop app (Electron + React + TypeScript, hand-written CSS, macOS Native
Finder fidelity) whose backend is the AutoRAG agent.

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
sections inline, each pane windowed on its own scroller (27px rows; issue #103,
`ColumnPane` in `components/ColumnBrowser.tsx`) — a 5,000-file pane keeps tens of
rows mounted, and a keyboard/reveal target outside the window is mounted for one
commit so `scrollIntoView` finds it; check: `scripts/manual-qa/run-qa-finder-column-large.mjs`. Native Finder criteria are populated by a background
`fs:finderMetadata` call, separate from the `fs:enrichEntries` call that fills
OS kinds and tile icons: creation time comes from the real filesystem birth
time, tags and comments use Finder extended attributes with Spotlight fallback,
dimensions read only the first 256 KiB of the image, Date Added / Date Last
Opened / rating use Spotlight, and Application uses Launch Services' default
opener. Those helper processes are far slower than the icon pool on a USB/HDD
volume, so icons never wait for them; each result patches only its own fields
on whatever rows are on screen when it lands. Both the metadata and thumbnail
queues serve the newest request first, so leaving a folder of thousands of
photos never stalls the next one. Unknown values remain unknown; they are never
replaced with modification time or an unrelated application.
Pure behavior is covered by `test/ui-sort.test.ts` and `test/ui-grouping.test.ts`.
### 1.3 Path bar
The path bar under the Finder list is one line at every window size and never shows an ellipsis. When the trail does not fit, labels give up space in a fixed order — middle segments left to right (`Users`, the home folder, …), then the root (`Macintosh HD`), then the parent of the current location, then the current location or selected file. A label first narrows with its last `--fade-label` (14px) faded out, so the word reads as cut off; once fewer than 32px would remain, the segment shows only its icon. If even the icon-only trail is too wide, it stays pinned to its end and fades in from the leading edge. Logic: `src/renderer/src/state/path-fit.ts`; visual check: `scripts/manual-qa/run-qa-finder-path-bar.mjs`.
### 1.3 Finder list density
The list view follows the Bloom Finder density contract: file rows are 24px high, names and metadata use 12px text, default file names use the primary near-black ink, and alternate rows use `#F4F5F5`. A focused selection fills the complete row with the accent color immediately, with no background-color transition and no visible corner rounding; an unfocused selection remains muted gray. Virtualized row geometry and keyboard reveal scrolling use the same 24px stride. The top Finder chrome uses larger 32px controls with 18px glyphs so navigation, sorting, view mode, and folder actions remain easy to target.
Fresh windows start with the sidebar at its minimum 180px width and the inspector at its minimum 300px width; user-resized values remain persisted.

**Icon view marquee.** A drag that starts on empty space in the icon view draws a rubber-band rectangle (`--accent` 1px border over `--accent-soft`) and selects every tile it touches, as Finder does: a plain drag replaces the selection, ⌘ toggles the touched tiles, ⇧ adds them, and holding past the top or bottom edge scrolls and keeps extending. A press that never moves clears the selection. Hits come from the virtualized layout math, not the mounted tiles, so a rectangle that scrolls past the window still selects what it covers. A drag that starts on a tile stays the row drag. Geometry: `src/renderer/src/state/marquee.ts` (`test/ui-marquee.test.ts`); pointer handling: `src/renderer/src/hooks/useMarquee.ts`.

**Batch file operations.** Trash, move, copy, and duplicate report a per-path outcome (`FsBatchResult`). Rows that went away (trashed, moved out) leave the listing, the column panes, expanded folders, search hits, and the selection right away instead of waiting for the watcher. A partial batch never looks done: the toast names both counts and the first failure's verbatim reason, and the failed rows stay on screen and stay selected. On macOS the iCloud Drive file provider (`~/Documents` and `~/Desktop` with Desktop & Documents sync) sometimes refuses the rest of a batch after the first one or two items with "you don't have permission to access it", and the refusal sticks to each file for 10–50 s. `fs:trash` clears it by renaming the item to a hidden sibling and straight back, then retries once (`trashOne` in `src/main/fs-service.ts`). The item keeps its name, so the Trash entry and Put Back look the same as Finder's.

**Undo and redo history (issue #89).** ⌘Z walks a bounded stack of the last 100 file operations instead of one record, and ⇧⌘Z redoes what ⌘Z took back; a new operation clears the redo side. The stack lives in the fs worker (`createFsService` in `src/main/fs-service.ts`): every recorded step is reversible and applying it returns its inverse, so undo and redo are the same walk over two stacks. Copy and duplicate undo by deleting the created row, move by moving it back with Finder-style collision naming, rename by taking the old name back (a retaken name fails instead of overwriting), New Folder / New File by deleting the created row (redo recreates it from the same template), trash by Put Back, and Put Back by trashing again. Compress and extract are produced by the action service, so the renderer reports each output through `recordCreated` and ⌘Z moves it to the Trash — recoverable, never a hard delete. A step that cannot apply reports its path with the verbatim reason, the toast names the operation (`historyToast`: "이름 변경 취소", "복사 다시 실행"), and the steps that did apply stay reversible. Emptying the Trash drops every step that would put a payload back. The history is per session and in memory only. QA: `scripts/manual-qa/run-qa-finder-undo-history.mjs`.

**Trash restore and empty (issue #86).** The Trash location behaves like Finder's: its rows carry the items' original names (Windows reads them from the `$I` records in `src/main/recycle-bin.ts`; macOS lists `~/.Trash` directly), and Put Back — the toolbar button, the row menu, or ⌘Z right after a trash — moves the payload back to the folder it came from. macOS keeps no per-item origin on disk, so `fs:trash` records one in an app-owned store (`src/main/trash-store.ts`, `trash.json` under userData); Windows needs none because the `$I` record is the origin. A payload nobody can place fails with its verbatim reason instead of a guess. A restore is itself undoable: ⌘Z re-trashes the row. 휴지통 비우기 permanently deletes every payload (on Windows its `$I` record goes with it; Finder's `.DS_Store` stays) only after a confirm dialog (`ConfirmDialog`), which Escape and the cancel button both dismiss, and the batch result names what went and each refusal. Automated checks: `test/fs-service.test.ts`, `test/trash-store.test.ts`; on-device lane: `scripts/manual-qa/run-qa-finder-trash-restore.mjs`.

### 1.3a AI Search tabs
AI Search is a tab view like Settings (`AI_SEARCH_PATH`, `src/renderer/src/state/tabs.ts`). Each AI Search tab owns its chat; the panel stays mounted while its tab is in the background or browses a folder, and unmounts when the tab closes. Entry points:
- **Sidebar → Favorites → AI Search**: the *focused* tab becomes AI Search (a navigation, so Back returns to the folder).
- **`⌘K`** and the toolbar sparkles: the nearest open AI Search tab, else a new one; the composer is focused.
- **Inspector "AI 요약"** and the sidebar search's **내용** chip: always a *new* AI Search tab, with the file attached or the query sent.
- **Drops**: Finder rows, OS files, and links attach when dropped on the AI Search panel, on an AI Search strip tab (it switches to that tab; dwelling springs it open), or on the sidebar AI Search item (the focused tab becomes AI Search). A Finder row dropped on an AI Search tab is attached, never moved.

**Row drag: inside vs. outside the app.** Electron cannot run one drag as both kinds — a native file drag (`webContents.startDrag`) never comes back to the window as an in-app drop, and an HTML5 drag never hands the OS real files — so the row drag is pointer-driven (`src/renderer/src/lib/row-drag.ts`) and the window edge is the switch (`src/renderer/src/state/row-drag.ts`). A press becomes a drag after 4px. **Inside the window** it is an in-app drag: a name ghost (with a count for a multi-row drag) follows the pointer, and the module dispatches `dragenter`/`dragover`/`drop`/`dragend` carrying the Finder payload to whatever is under it, so a folder tab (dwelling springs it open) and AI Search keep their own handlers. In a listing, a folder row takes the rows; anywhere else in a pane — a file row or empty space — they land in the folder that pane shows (`backgroundDropDir`), the whole listing highlighted. Rows move; ⌥ (pressed before or during the drag) copies, and an ⌥-drop into the rows' own folder duplicates them Finder-style ("name copy"). The cursor shows the verb (`html[data-row-drag]`); Escape cancels. **Once the pointer leaves the window** the in-app drag ends and the main process starts the OS file drag over `fs:startDrag` with every dragged path, so the rows reach Finder, Mail, or any other app as real files; the drag image is the first row's OS icon, and the OS shows its own copy/move badge. A drag that went out stays native.

A drop on a **Finder drop target** — a folder row, a folder tab, or the listing background — is a file transfer instead: OS files and folders dragged in from another app land in that folder, copied by default and moved with `⌥` (an in-app row drag keeps Finder's own default, moving, and `⌥` copies). Only absolute paths resolved through Electron's `webUtils.getPathForFile`, a `file:` URI-list line, or the Finder's own row payload are trusted; a web link resolves to no local path and does nothing. Name collisions take Finder-style numbering in main (`uniqueChild`), and the transfer is the same recorded copy/move `⌘Z` undoes. Logic: `state/attachments.ts` (`readDropPaths`, `isFileTransferDrag`) and `state/file-transfer.ts` (`dropTransferOp`, `planTransfer`); tests: `test/ui-attachments.test.ts`, `test/ui-file-transfer.test.ts`.

A Settings or AI Search tab lists no rows: ⌘T opens a folder tab on the last folder it showed, and a filename search returns the tab to that folder. Pure behavior: `test/ui-tabs.test.ts`; on-device check: `scripts/manual-qa/run-qa-finder-ai-search-tab.mjs`.

The inspector follows the focused tab and shows one full-height view: a folder tab shows **Info** for its selection, and an AI Search tab shows **Evidence** — the cited sources of that tab's answer, numbered, with feedback and excerpts. A citation chip selects its source. A source title acts by kind: a local file opens its folder in a new tab with the file selected, a datasource id (`/kakao/…`) is plain text, and an `http(s)` page opens in the OS default browser through `fs:openUrl` (`shell.openExternal`). Main re-checks the scheme with the shared `webUrl`, so `file:` and custom schemes are refused. On-device check: `scripts/manual-qa/run-qa-finder-evidence-panel.mjs`.

**Images in answers and evidence.** `parseInline` (`src/renderer/src/state/answer-markdown.ts`) reads three spellings as image references: a markdown image `![alt](ref)` (plain or `<ref>` form), inline code holding an absolute image path or URL, and a bare absolute image path in a sentence (it ends at the extension, so a Korean particle or a final period stays text). A markdown image renders only as the picture; a path the model wrote in a sentence stays as text, and its picture appears under the line. `imageTarget` resolves each reference, and `components/AnswerImage.tsx` renders it:
- **Local, drawable** (`viewerForExtension` = `image`): the picture streams through `autorag-preview://`, the same protocol Quick Look uses (`img-src` already allows it). In answer prose it has no caption, since the Evidence panel already names each source, and the full path shows on hover. In evidence excerpts it is captioned with the file name. Clicking it opens Quick Look.
- **Local, not drawable** (HEIC, TIFF): a card with the name and path. Clicking it opens Quick Look, which converts the file.
- **Missing or unreadable**: when `<img>` errors, a card with the name, the path, and "이미지를 불러올 수 없습니다". No broken image.
- **Web image**: never fetched from model output. A card shows the URL and opens the page in the OS browser through the same `webUrl`-checked path as a web source.
- **Relative link**: in an evidence excerpt it resolves against the cited file's folder (`resolveRelative`); in an answer there is no document to resolve against, so the card shows the link as written.

An image evidence source shows the picture itself in the Evidence paper. Pure behavior: `test/ui-answer-markdown.test.ts`; on-device check: `scripts/manual-qa/run-qa-finder-ai-search-images.mjs`.

### 1.3b Split panes
The Finder area is a workspace of panes (`src/renderer/src/state/workspace.ts`). A pane is one tab strip, its active tab's view, and that tab's path bar; Settings and AI Search tabs belong to panes like folder tabs. Every strip tab can be dragged, PyCharm-style:
- **Onto a pane's edge band** (outer 30% of its body, nearest edge wins): that pane splits and the tab becomes the new half — left/right side by side, top/bottom stacked. A split in the same direction as its parent becomes a sibling taking half the target's share instead of nesting.
- **Onto a pane's body middle**: the tab merges into that pane after its last tab.
- **Onto a tab strip**: the tab is inserted at the caret (tab midpoints decide the gap); in its own strip this reorders.

While dragging, an accent outline previews the result — the half that would become the new pane, the whole pane for a merge, or the strip with an insertion caret — and glides between zones. A drop that would change nothing (a pane's only tab onto its own body or edge) shows no preview. Panes opening, closing, or moving glide with `--dur-pane` / `--ease-pane`, and a new pane fades in (`paneIn`); window resizes and seam drags track 1:1, and reduced motion keeps only the fade. A 1px seam separates neighbors; dragging it resizes them (about 220px minimum each), and at a T-junction the seam that runs through wins.

A pane whose last tab closes or leaves disappears and its share goes to its neighbor, so the panes always tile the area and a lone pane is full width again. The window's last tab never closes. The workspace remembers tab focus, newest first: closing the focused pane returns focus to the pane of the tab focused before it (not a geometric neighbor), closing an active tab shows that pane's previously focused tab, and new tabs — ⌘T, Evidence "Show in Finder", "Show in Enclosing Folder", AI 요약 — open in the focused pane, which is the pane of the last focused tab. Only the focused pane answers the keyboard, and with more than one pane its active tab carries an accent underline; the toolbar, sidebar, inspector, and context menu follow it. ⌘K focuses an AI Search tab already on screen in any pane before opening one; ⌘, selects the open Settings tab wherever it is. Pure behavior: `test/ui-workspace.test.ts`; on-device check: `scripts/manual-qa/run-qa-finder-split-panes.mjs`.

### 1.4 Info panel metadata
Selecting an entry reads its rich metadata on demand through `fs:details` (`FsFileDetails`): kind, size, where, absolute path, creation/modified/accessed/change times, symlink target, permission string, owner, group, and inode; image files additionally carry an EXIF block (`FsImageMetadata`) read by `src/main/image-metadata.ts` (exifr) — dimensions, make, model, lens, ISO, aperture, shutter, focal length, capture time, and more. The panel body scrolls, so a photo's full tag list never stretches the column.

The preview paper above the metadata shows the file's real content, not a type icon: `fs:previewIcon` renders a 640px Quick Look thumbnail in the main process (same bounded pool, single-flight map, and LRU cache as the 128px listing tier, keyed `(path, mtime, size)` and served through the `autorag-thumb://` protocol's optional `size` parameter; generation runs on its own two-permit lane so a slow listing batch never makes the panel wait). There is no fixed frame: the image takes the panel's full width and its own aspect ratio sets the height (capped at 70vh), so a portrait PDF fills the column instead of letterboxing. The paper is that frame from the very first paint — while the tier loads it is a blank sheet at the last known aspect, then the content fades in and the aspect-ratio transition settles the height, so nothing ever snaps. A process-local `(path, mtime) → preview + aspect` cache means re-selecting a file renders the final layout within a frame or two, with no repeat IPC. The compact bordered box (listing icon or letter tile) only appears for folders and files the OS provably has no preview for.

HWP and HWPX are the one exception to the OS thumbnailer: neither macOS nor Windows can draw them without Hancom's plug-in, so the renderer draws the paper itself with rhwp (`src/preview/ui/rhwp.ts`, the engine Quick Look pages HWP with) — the first page as an SVG data URL, read through `autorag-preview://`, with only the most recent 24 kept in the paper cache since each is a full page of SVG.

Scrollbars are deliberately unstyled (base.css §7): any `::-webkit-scrollbar` rule forces Chromium's classic scrollbars, which consume layout width and visibly shift the preview and metadata rows whenever the panel starts or stops scrolling. Leaving them untouched keeps the macOS-native overlay scrollbars that float above the content, so no surface ever changes width; on-device check: `scripts/manual-qa/run-qa-finder-overlay-scrollbars.mjs`.

A multi-selection replaces the single-file panel with the aggregate view (`src/renderer/src/state/inspector-multi.ts`): a fan of up to five of the selection's own preview papers, each sheet dog-eared (`.page-curl`) and drop-shadowed, deeper sheets rotated wider and stepped further out, focused file in front; then the "N개 항목" title, the per-kind breakdown with the total size ("PDF document 2개 · 1 KB", tails folded into 외 N종), and 생성한/수정한 날짜 date ranges that collapse to one date on a shared day. Per-file affordances — the index chip, the Versions family, the action bar — stay single-selection only. On-device check: `scripts/manual-qa/run-qa-finder-inspector-preview.mjs`.

The list is expanded by default and the "간략히 / 전체 정보" button collapses it to the core summary (kind, size, where, path, created, modified); the button only appears when there is a non-core row to hide. Labels, ordering, and the collapse rule live in `src/renderer/src/state/inspector-info.ts`; automated check: `test/ui-inspector-info.test.ts`; on-device check: `scripts/manual-qa/run-qa-finder-info-metadata.mjs`.

### 1.5 Sidebar places
Every sidebar row comes from the OS, through `fs:locations` (`src/main/places.ts`); nothing is a fixed provider or drive list, and a group with no rows is not rendered.
- **Favorites** — the **AI Search** app row (§1.3a), then Recents, then Finder's standard places: the home folder, Applications, Desktop, Documents, Downloads, Music, Movies, Pictures, Trash (`~/.Trash`). On Windows the same slots use Explorer's names and the real known-folder paths (OneDrive folder redirection honored), Program Files, and the user's `$Recycle.Bin\<SID>`, whose `$R` payloads are listed under their original names (`src/main/recycle-bin.ts`); the Trash row restores and empties its contents (§ "Batch file operations"). A missing folder stays in its slot, dimmed.
- **Cloud** — exactly the drives connected to the OS, one row per account: iCloud Drive plus every `~/Library/CloudStorage/<Provider>-<account>` File Provider domain on macOS (e.g. `Google Drive - me@example.com`, `OneDrive - Personal`); the `SyncRootManager` roots registered for the user's SID and a Google Drive virtual drive letter on Windows.
- **Locations** — the boot disk (`/`, or the system drive) plus every browsable mounted volume: `/Volumes/*` mount points without `nobrowse`, or every other drive letter. Each carries an eject button flush right; ejecting moves tabs out of the volume first (so no watcher holds it), then runs `diskutil unmount` (macOS), `net use X: /delete` for network drives, or the shell Eject verb (Windows). A refusal surfaces verbatim in the toast.

The fs worker (`src/fs-worker/`, see README "Filesystem worker") polls a cheap mount signature (volume names and device ids, cloud domains) every 2s and pushes `fs:locationsChanged`, so a volume or cloud account that comes or goes updates the sidebar without a restart. The dupey scan walks only `scanned` places (Desktop, Documents, Downloads, cloud drives) — never the home folder or a whole disk. Rows are 28px with 12px labels and 14px glyphs. Automated checks: `test/places.test.ts`, `test/ui-places.test.ts`; on-device check (attaches and ejects a real disk image): `scripts/manual-qa/run-qa-finder-sidebar-places.mjs`.

Instant Search's filename search ("전체" and "파일 이름") answers from the platform name index first, through `src/main/file-name-search.ts`: the user's `fsearch-cli` database on macOS/Linux (the same default database the FSearch app shares) and the bundled voidtools Everything on Windows. "파일 이름" narrows the index request to the folder in view before its result cap. When no index is installed or no database answers, the search falls back to the bounded disk walk over the `scanned` places. The app warms the index at launch — a `fsearch-cli watch` daemon on macOS/Linux, the Everything instance on Windows — and deliberately leaves it running across quits, because restarting a watch over a whole-machine database re-scans every monitored folder. Automated checks: `test/file-name-search.test.ts`, `test/fs-service.test.ts`; on-device check: `scripts/manual-qa/run-qa-finder-fsearch-search.mjs`.

### 1.6 macOS application bundles
A `.app` is a directory on disk, but macOS treats it as one launchable item, and so does the app. `buildFsEntry` reports such a directory as `kind: "file"` with ext `app` — on darwin only (`src/main/fs-entry.ts`). Everything keyed on the kind then follows: the row gets an OS-provided tile icon and the OS kind ("Application", Finder's own answer), where a folder gets neither; Enter and double-click launch the bundle through `shell.openPath` instead of navigating into its `Contents/`; and the Size cell keeps "—", because the entry is still a directory whose byte count would be the folder's own rather than the app's. Off macOS the same directory stays a folder.

The app's own icon comes from the native thumbnail lane, which renders a bundle exactly like a document (`"app"` in `NATIVE_THUMBNAIL_EXTENSIONS`, `src/main/file-icon.ts`) — at the 128px listing tier and at the Inspector's 640px preview tier. Should generation produce nothing, the tile falls back to the `app` kind's letter tile (`--tile-app`); it is the one entry in `KIND_ORDER` that is not part of the reference KD map. Automated checks: `test/fs-entry.test.ts`, `test/file-icon.test.ts`, `test/entries.test.ts`; on-device check (lists and launches a real hand-built bundle): `scripts/manual-qa/run-qa-finder-app-bundles.mjs`.

---

## 2. Keyboard Shortcuts

| Shortcut | Scope | Behavior |
|---|---|---|
| `⌘,` | Global | Open or focus Settings tab |
| `⌘T` | Window | Open new Finder tab |
| `⌘W` | Window | Close current Finder tab |
| `⌘F` | Window | Focus Instant Search bar |
| `⌘K` | Window | Show the nearest AI Search tab (or open one) and focus its composer |
| `⌘Z` | Finder | Undo the newest file operation (copy, move, duplicate, rename, New Folder / File, trash, Put Back, compress, extract); repeats back through the last 100 |
| `⇧⌘Z` | Finder | Redo the operation the last ⌘Z took back |
| `⇧⌘N` | Finder | New folder in the folder in view (inline rename starts at once) |
| `⌥⌘N` | Finder | New text file in the folder in view (inline rename starts at once) |
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
- The same headline actions sit in the row context menu (`state/context-menu.ts`):
  다른 앱으로 열기 in the open group, and 새 폴더 · 압축 해제(`.zip` only) · 압축 ·
  공유 in a group above 휴지통으로 이동. The same capability gates apply, the Trash
  offers none of them, and a multi-selection keeps only the batch-meaningful
  items — 압축 packs the whole selection into one `Archive.zip`, 공유 opens one
  sheet, and 압축 해제 disappears. The menu's 다른 앱으로 열기 is the Inspector's
  `기타…`: the full application chooser, one launch for the whole selection.
- **다른 앱으로 열기** opens an in-app menu, not the native chooser. The first
  rows are the applications the OS itself registers for the file's type
  (Launch Services `URLsForApplicationsToOpenURL`, via
  `actions:open-with-applications`), default first and marked `(기본)`, each with
  its own icon. `기타…` is pinned last and is the only entry that opens the
  full application chooser. A named application must be one the OS offered for
  that file; main refuses anything else. Off macOS the OS list cannot be read,
  so the menu is just `기타…`.
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
