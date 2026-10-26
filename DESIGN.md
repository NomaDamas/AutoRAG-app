# Dazzi Design System (v7 Bloom)

Implementation contract and design specification for **Dazzi** (powered by AutoRAG) — the AI Finder
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
- **One bundled typeface:** The UI is set in Pretendard Variable (SIL OFL 1.1), shipped in `src/renderer/styles/fonts/` and declared in `fonts.css`, so Latin and Korean glyph widths — and with them line breaks and the fit of fixed-size controls — are identical on every OS. `--font-sans` starts with it; the OS UI fonts after it only cover glyphs it lacks. `body` sets `font-variant-ligatures: none` because Pretendard rewrites `1x2` as `1×2`, and file names must be drawn as stored.
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

**Editing the path.** A folder segment navigates. A click anywhere else on the bar (the gap between segments, the strip after the trail, the volume or selected-file segment) swaps the trail for a text field holding the full path, all selected. The bar keeps a 24px right padding, so that strip exists even when the trail fills the width. Enter goes to the typed location: an absolute POSIX, drive or UNC path, `~/…`, a `file://` URL, a quoted path, or a path relative to the folder in view. A folder opens in the tab; a file opens its folder with the file selected. A location that does not exist shows a toast and leaves the field open with the text selected. Escape, a click elsewhere, or any navigation closes the field. Enter and Escape stay inside the field, and the trail stays mounted (invisible) under it, so the fit never goes stale. Resolution: `resolvePathInput` in `src/renderer/src/state/paths.ts` (`test/ui-paths.test.ts`); field behaviour: `test/ui-path-bar-edit.test.tsx`.

A typed path can differ from the disk in case (`/volumes/ssd1/autorag`) or Unicode form (a Korean name typed NFC, stored NFD); a case-insensitive volume (the APFS and NTFS default) still opens it. The tab and the path bar still show the on-disk spelling: `fs.stat` maps every segment back to its directory entry, matched by case and Unicode form and confirmed by inode, and never resolves a symlink. The renderer then navigates to the path it gets back. Logic: `onDiskPath` in `src/main/fs-entry.ts` (`test/fs-entry.test.ts`).
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
- **`⌘K`**: the nearest open AI Search tab, else a new one; the composer is focused. The toolbar has no AI Search control.
- **Inspector "AI 요약"** and the sidebar search's **내용** chip: always a *new* AI Search tab, with the file attached or the query sent.
- **Drops**: Finder rows, OS files, and links attach when dropped on the AI Search panel, on an AI Search strip tab (it switches to that tab; dwelling springs it open), or on the sidebar AI Search item (the focused tab becomes AI Search). A Finder row dropped on an AI Search tab is attached, never moved.

**Row drag: inside vs. outside the app.** Electron cannot run one drag as both kinds — a native file drag (`webContents.startDrag`) never comes back to the window as an in-app drop, and an HTML5 drag never hands the OS real files — so the row drag is pointer-driven (`src/renderer/src/lib/row-drag.ts`) and the window edge is the switch (`src/renderer/src/state/row-drag.ts`). A press becomes a drag after 4px. **Inside the window** it is an in-app drag: a name ghost (with a count for a multi-row drag) follows the pointer, and the module dispatches `dragenter`/`dragover`/`drop`/`dragend` carrying the Finder payload to whatever is under it, so a folder tab (dwelling springs it open) and AI Search keep their own handlers. In a listing, a folder row takes the rows; anywhere else in a pane — a file row or empty space — they land in the folder that pane shows (`backgroundDropDir`), the whole listing highlighted. Rows move; ⌥ (pressed before or during the drag) copies, and an ⌥-drop into the rows' own folder duplicates them Finder-style ("name copy"). The cursor shows the verb (`html[data-row-drag]`); Escape cancels. **Once the pointer leaves the window** the in-app drag ends and the main process starts the OS file drag over `fs:startDrag` with every dragged path, so the rows reach Finder, Mail, or any other app as real files; the drag image is the first row's OS icon, and the OS shows its own copy/move badge. A drag that went out stays native.

A drop on a **Finder drop target** — a folder row, a folder tab, or the listing background — is a file transfer instead: OS files and folders dragged in from another app land in that folder, copied by default and moved with `⌥` (an in-app row drag keeps Finder's own default, moving, and `⌥` copies). Only absolute paths resolved through Electron's `webUtils.getPathForFile`, a `file:` URI-list line, or the Finder's own row payload are trusted; a web link resolves to no local path and does nothing. Name collisions take Finder-style numbering in main (`uniqueChild`), and the transfer is the same recorded copy/move `⌘Z` undoes. Logic: `state/attachments.ts` (`readDropPaths`, `isFileTransferDrag`) and `state/file-transfer.ts` (`dropTransferOp`, `planTransfer`); tests: `test/ui-attachments.test.ts`, `test/ui-file-transfer.test.ts`.

A Settings or AI Search tab lists no rows: ⌘T opens a folder tab on the last folder it showed, and a filename search returns the tab to that folder. Pure behavior: `test/ui-tabs.test.ts`; on-device check: `scripts/manual-qa/run-qa-finder-ai-search-tab.mjs`.

**Steering a running search (issue #176).** The composer stays live while a search runs. **Enter** steers that search: the text is a correction of the search in flight, not a new question. Main hands it to the running agent (`search:steer` → `AutoRAGAgent.steer`), which delivers it before the run's next model request (also between phases), cuts an in-flight retrieval or the baseline prefetch short, and always runs the verification phase, so the Deep answer follows the correction. **⌥Enter** queues the text as the next question, asked once the run ends; a queued question shows as a dashed "다음 질문" chip with an × to cancel it. **Esc** / Stop stops the whole search, and questions queued behind it go back into the composer unasked. A steer shows as a right-aligned user bubble where it was sent: above the Quick answer when sent before it, between Quick and Deep when sent after it. While no model request has taken it yet, the bubble wears a dashed accent outline whose ring breathes, with a pulsing dot and "반영 대기 중 · 다음 단계에 전달됩니다"; `steer-delivered` turns it into a solid bubble with a check and "검색에 반영됨". A steer the run never took (it ended first) is struck through. A steer the run refuses (past its last model request) becomes the next question instead. Steers carry text only; drafted attachments stay in the tray for the next question. History keeps each steer as a user turn tagged `before-quick` / `after-quick`. Pure behavior: `test/ui-steering.test.ts`, `test/search-service.test.ts`; on-device check: `scripts/manual-qa/run-qa-finder-ai-search-steer.mjs`.

The inspector follows the focused tab and shows one full-height view: a folder tab shows **Info** for its selection, and an AI Search tab shows **Evidence** — the cited sources of that tab's answer, numbered, with excerpts. A citation chip selects its source. A source title acts by kind: a local file opens its folder in a new tab with the file selected, a datasource id (`/kakao/…`) is plain text, and an `http(s)` page opens in the OS default browser through `fs:openUrl` (`shell.openExternal`). Main re-checks the scheme with the shared `webUrl`, so `file:` and custom schemes are refused. On-device check: `scripts/manual-qa/run-qa-finder-evidence-panel.mjs`.


**Evidence Folder (Ask-as-Smart-Folder).** At the top of the Evidence view, beside the numbered citation tabs, sits the **근거 폴더 / Evidence Folder** button (`[data-action="evidence-folder"]`). Clicking it collects every unique local file cited across all turns of the current AI Search conversation (`collectSessionEvidence`, `sessionEvidencePaths` in `src/renderer/src/state/evidence.ts`), creates a temporary folder populated with symlinks (falling back to hardlinks/copies on restricted platforms) via `fs.createEvidenceFolder` (`src/main/fs-service.ts`), and opens it in a new Finder tab (`openEvidenceFolderTab` in `src/renderer/src/state/tabs.ts`). Because the entries are symlinks inside a real temporary directory, zero extra disk space is consumed while Inspector Info, Quick Look (`Space`), inline rename (`⌘R`, renaming the link without touching the source file), and copy/paste or drag-out (`copy`/`move` dereference symlinks into standalone files at the destination, even after the Evidence Folder is removed) work identically to any folder. Closing an Evidence Folder tab (`×` or `⌘W`) opens a confirmation `ConfirmDialog`; confirming closes the tab and deletes the temporary directory (`fs.removeEvidenceFolder`), and navigating that tab outside the Evidence Folder cleans up the temporary directory and strips its paths from back/forward history (`retainEvidenceFolder`). Returning to the conversation in AI Search (or restoring it from Chat History) and clicking **근거 폴더 / Evidence Folder** recreates the temporary folder on demand. Automated checks: `test/ui-evidence.test.ts`, `test/ui-tabs.test.ts`, `test/ui-workspace.test.ts`, `test/fs-service.test.ts`; on-device check: `scripts/manual-qa/run-qa-finder-evidence-folder.mjs`.
**Excerpt formats.** An excerpt is a chunk cut out of a parsed document, so its markup is rarely whole: a spreadsheet or HWP table arrives as HTML rows with no `<table>` around them, often starting inside a cell (`…</td><td>`) and ending inside a tag (`<td`), and a markdown table may have lost its header row. `splitExcerpt` (`src/renderer/src/state/excerpt-format.ts`) cuts each excerpt into parts by line: lines carrying a block-level tag (and lines between them while an element is still open) are **HTML**; consecutive `|` lines, with or without the header and delimiter rows, are a **pipe table**; everything else is **markdown** for `parseAnswerBlocks`. Tags inside a code fence or an inline code span stay code. `repairHtmlFragment` drops a partial tag at either end, opens the table/row/cell that leading orphan closing tags belong to, wraps bare rows and cells in a table (the HTML parser discards `<tr>`/`<td>` outside one), and closes what is left open. `components/EvidenceBlocks.tsx` then runs HTML through `sanitizeMarkdownHtml`, the same allowlist the Quick Look markdown preview uses (no scripts, handlers, remote images, or non-web links; relative images resolve against the cited file's folder, or are dropped for datasource and web sources). Both table forms render compact in a bordered frame that scrolls sideways inside the narrow column. An `http(s)` link in chunk HTML opens in the OS browser; any other link is inert. Pure behavior: `test/ui-excerpt-format.test.ts`, `test/ui-evidence-excerpt.test.tsx`; on-device check: evidence 5 of `scripts/manual-qa/run-qa-finder-evidence-panel.mjs`.

**Tables in answers.** A GFM pipe table in an answer (the model's own `| a | b |` rows) renders as a table, not as literal pipes. `parseAnswerBlocks` (`src/renderer/src/state/answer-markdown.ts`) reuses the evidence table parser (`pipeTableLength` / `pipeTable` in `excerpt-format.ts`) and emits a `table` block with header, column alignment, and `<br>` in-cell breaks; a table inside a code fence stays code, and a lone `|` line stays a paragraph. `components/PipeTable.tsx` is the one table frame shared with the Evidence panel; answer cells render their inline markdown through the same segment renderer as prose, so `[n]` citation chips in a cell stay clickable (an unresolved one is dropped). Pure behavior: `test/ui-answer-markdown.test.ts`, `test/ui-answer-table.test.tsx`; on-device checks: `scripts/manual-qa/run-qa-finder-ai-search-table.mjs` (seeded; runs in the VM) and `scripts/manual-qa/run-qa-live-ai-search-table.mjs` (a real model through the Dazzi service; needs an account key, so it runs on this machine, not in the VM).

**Links in answers and evidence.** `parseInline` reads an `http(s)` URL as a `link` segment in three spellings: a markdown link `[label](https://…)` (optional `"title"`, a `<url>` destination, one level of balanced parentheses), an `<https://…>` autolink, and a bare URL in a sentence. A bare URL is the longest run of ASCII URL characters, so a Korean particle (`…/docs에서`) ends it, and a trailing `. , ; : ! ? ' *` or a `)` with no `(` to close stays text. Only `http(s)` becomes a link: `[x](javascript:…)`, `file:`, `mailto:`, relative paths, and scheme-less hosts (`www.…`) keep their old reading as text, and `[1](3쪽)` is still a citation chip followed by text. A label holds bold and code but never another link (a URL used as its own label is one link); `**[label](url)**` and `**https://…**` put the weight on the link. `components/AnswerLink.tsx` renders the segment for answer prose (`AiSearchPanel`) and Evidence excerpts (`EvidenceBlocks`) as a real `<a href>` (focusable, Enter works) whose click, Cmd/Ctrl-click, and middle click are all cancelled, so the Finder window never navigates or opens another window; the URL goes to `ImageActions.onOpenUrl` → `fs:openUrl` (`shell.openExternal`; main re-checks `webUrl`). Pure behavior: `test/ui-answer-markdown.test.ts`, `test/ui-answer-links.test.tsx`; on-device checks: `scripts/manual-qa/run-qa-finder-ai-search-links.mjs` (seeded; runs in the VM) and `scripts/manual-qa/run-qa-live-ai-search-links.mjs` (a real model through the Dazzi service; needs an account key, so it runs on this machine, not in the VM).

**Code in answers and evidence.** A fenced block keeps the fence's language word (`parseAnswerBlocks` returns `{ kind: "code", text, language }`, the first word of the info string, lowercased) and `components/CodeBlock.tsx` draws it coloured, in answers and in evidence excerpts alike. `src/preview/ui/highlight.ts` is the one highlight.js setup of the app, shared with Quick Look's code views: `highlightGrammar` resolves a fence word (`python`, `py`, `tsx`, `shell`, `yml`, `html`, ...) through the extension table, a few fence aliases, then highlight.js's own aliases; a fence with no language or no grammar stays plain text. `highlightCode` escapes every character of the source and adds only highlight.js's `<span class>` tokens, so the HTML it returns is safe to set as `innerHTML`. The token colours are `src/preview/ui/syntax.css` (the `--ql-syntax-*` palette, light and dark), scoped to `.ql-lines` (Quick Look) and `.hl-code` (answers, evidence) and imported by both stylesheets, so one source reads the same in either place. Pure behavior: `test/ui-code-highlight.test.tsx`, `test/ui-answer-markdown.test.ts`; on-device checks: `scripts/manual-qa/run-qa-finder-ai-search-code.mjs` (seeded; runs in the VM) and `scripts/manual-qa/run-qa-live-ai-search-code.mjs` (a real model, through the Dazzi service or `QA_OPENROUTER_MODEL`; needs a key, so it runs on this machine, not in the VM).

**Images in answers and evidence.** `parseInline` (`src/renderer/src/state/answer-markdown.ts`) reads three spellings as image references: a markdown image `![alt](ref)` (plain or `<ref>` form), inline code holding an absolute image path or URL, and a bare absolute image path in a sentence (it ends at the extension, so a Korean particle or a final period stays text). A markdown image renders only as the picture; a path the model wrote in a sentence stays as text, and its picture appears under the line. `imageTarget` resolves each reference, and `components/AnswerImage.tsx` renders it:
- **Local, drawable** (`viewerForExtension` = `image`): the picture streams through `autorag-preview://`, the same protocol Quick Look uses (`img-src` already allows it). In answer prose it has no caption, since the Evidence panel already names each source, and the full path shows on hover. In evidence excerpts it is captioned with the file name. Clicking it opens Quick Look.
- **Local, not drawable** (HEIC, TIFF): a card with the name and path. Clicking it opens Quick Look, which converts the file.
- **Missing or unreadable**: when `<img>` errors, a card with the name, the path, and "이미지를 불러올 수 없습니다". No broken image.
- **Web image**: never fetched from model output. A card shows the URL and opens the page in the OS browser through the same `webUrl`-checked path as a web source.
- **Relative link**: in an evidence excerpt it resolves against the cited file's folder (`resolveRelative`); in an answer there is no document to resolve against, so the card shows the link as written.

An image evidence source shows the picture itself in the Evidence paper. Pure behavior: `test/ui-answer-markdown.test.ts`; on-device check: `scripts/manual-qa/run-qa-finder-ai-search-images.mjs`.

**Approval mode and questions.** Left of the AI Search message box, inside its rounded frame, sits a pill with the mode (`components/ApprovalModeMenu.tsx`): **Ask**, **Auto** (the default) or **Full**, each a shield icon; Full is drawn in the warning tokens, since it changes files without asking. The popover (`role="menu"`, `menuitemradio`) names what each mode does and works with arrows, Home/End, Enter, Esc and a click outside; every tab shows the same mode (`interaction.onMode`). While the agent waits for the person, `components/InteractionDock.tsx` takes the composer's place (the same width as the message box, `rounded-12`, `bg-input`); the draft text and attachments come back with the box. A **question card** lists options as large click targets (radio or checkbox look, title and muted description, number keys 1-9, arrows move, free text under "Write your own answer", Enter sends, Shift+Enter breaks the line, a Hangul IME's composing Enter never sends); a single choice answers at once, several picks or free text need Send; 2-4 questions show a `1 / 3` counter, Back / Next and an answered count, and Skip dismisses. An **approval card** shows a shield, what the call does (category chips), the command in a monospace block, and Allow once / allow for this session / Deny / "Deny and tell the model…" (an inline note); initial focus is on Deny, Esc denies, and Enter on the card never approves. A Stop button stays on both cards. Pure behavior: `test/interaction-state.test.ts`, `test/interaction-dock.test.tsx`, `test/approval-mode-menu.test.tsx`; on-device checks: `scripts/manual-qa/run-qa-finder-ai-search-interaction.mjs` and `run-qa-live-ai-search-interaction.mjs`.

### 1.3b Split panes
The Finder area is a workspace of panes (`src/renderer/src/state/workspace.ts`). A pane is one tab strip, its active tab's view, and that tab's path bar; Settings and AI Search tabs belong to panes like folder tabs. Every strip tab can be dragged, PyCharm-style:
- **Onto a pane's edge band** (outer 30% of its body, nearest edge wins): that pane splits and the tab becomes the new half — left/right side by side, top/bottom stacked. A split in the same direction as its parent becomes a sibling taking half the target's share instead of nesting.
- **Onto a pane's body middle**: the tab merges into that pane after its last tab.
- **Onto a tab strip**: the tab is inserted at the caret (tab midpoints decide the gap); in its own strip this reorders.

While dragging, an accent outline previews the result — the half that would become the new pane, the whole pane for a merge, or the strip with an insertion caret — and glides between zones. A drop that would change nothing (a pane's only tab onto its own body or edge) shows no preview. Panes opening, closing, or moving glide with `--dur-pane` / `--ease-pane`, and a new pane fades in (`paneIn`); window resizes and seam drags track 1:1, and reduced motion keeps only the fade. A 1px seam separates neighbors; dragging it resizes them (about 220px minimum each), and at a T-junction the seam that runs through wins.

A pane whose last tab closes or leaves disappears and its share goes to its neighbor, so the panes always tile the area and a lone pane is full width again. The window's last tab never closes. The workspace remembers tab focus, newest first: closing the focused pane returns focus to the pane of the tab focused before it (not a geometric neighbor), closing an active tab shows that pane's previously focused tab, and new tabs — ⌘T, Evidence "Show in Finder", "Show in Enclosing Folder", AI 요약 — open in the focused pane, which is the pane of the last focused tab. Only the focused pane answers the keyboard, and with more than one pane its active tab carries an accent underline; the toolbar, sidebar, inspector, and context menu follow it. ⌘K focuses an AI Search tab already on screen in any pane before opening one; ⌘, selects the open Settings tab wherever it is. Pure behavior: `test/ui-workspace.test.ts`; on-device check: `scripts/manual-qa/run-qa-finder-split-panes.mjs`.

### 1.3c Automations tab
The librarian's file automations (a folder to watch, a trigger, a command; stored in `<AUTORAG_HOME>/automations.json`) are listed in a tab view like Settings (`AUTOMATIONS_PATH`, `src/renderer/src/state/tabs.ts`), reached from **Sidebar → Favorites → Automations** (right under AI Search; the focused tab becomes the list, so Back returns, and an open Automations tab is focused instead of opening a second). The visual spec is `docs/prototypes/automations`.
- **List.** One Finder-style row per rule: its plain-language name (`ruleTitle`: "새 PDF → Dazzi에게 맡기기"), the watched folder (the user's standard folders in the interface language, several folders as "Notes 외 1곳"), the last run, and a status dot (green after a clean run, orange after a failure, hollow before any run). The footer says whether the background service runs the rules and offers 켜기 / 끄기; it is hidden for a user with no rules file. A rules file the librarian refuses shows its reason instead of an empty list; an empty file invites adding the first rule.
- **Inspector.** Selecting a rule shows its trigger → action, last run, and a three-row summary (언제 / 하는 일 / 문제); 전체 정보 adds the machine fields. A folder's own inspector lists the rules that watch it (recursive watch: also a folder inside a watched one), and a file shows nothing new. **With nothing selected, inside a folder some rule watches, the panel is about that folder** (`state/inspector-target.ts`), so its rules are readable without selecting anything; a folder nothing watches, a search, and a multi-selection keep the Finder's empty or summary panel. That folder is not a row of the listing, so the panel shows no size or date it does not know, and offers no 휴지통.
- **Space** opens an in-renderer Quick Look card (언제 / 하는 일 / 대상 폴더) that follows ↑/↓; **Enter** or double click edits; **Delete** / **⌘⌫** asks to delete; **Esc** closes the topmost layer. Right click offers the same actions.
- **Edit and add are an AI Search draft, never a sent question.** They open a NEW AI Search tab whose composer already holds a request in the interface language ("이 자동화 규칙을 수정해줘 — downloads-pdf-summary (다운로드에 PDF 파일이 새로 생기면). 바뀔 내용: " / "새 자동화 규칙을 만들어줘. 언제, 어떤 파일에, 무엇을 할지: ") and stops where the person types; nothing is sent until they press Enter, and the librarian agent's `manage_automations` tool then writes the file. The delivery path is `deliverToAi({ draft })` → `AiDockHandle.prefill` (`state/ai-delivery.ts`); a query beats a draft, and a summary run owns the turn.
- **Delete** confirms once (the folder and its files stay), removes only that entry from the rules file (every other entry is kept as written, unknown fields included), and a toast offers 실행 취소 for 5 s, which puts the entry back at its old position.
- Rules changed behind the app's back (the agent, another window, the CLI) appear without a click: the main process polls cheap file signatures and pushes `automations:changed` only when the CLI-backed snapshot differs.
Pure behavior: `test/ui-automations*.test.ts(x)`, `test/ui-automation-*.test.tsx`, `test/ui-ai-delivery.test.ts`, `test/automation-service.test.ts`; on-device check: `scripts/manual-qa/run-qa-finder-automations.mjs`.

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

The fs worker (`src/fs-worker/`, see `docs/architecture.md` "Filesystem worker") polls a cheap mount signature (volume names and device ids, cloud domains) every 2s and pushes `fs:locationsChanged`, so a volume or cloud account that comes or goes updates the sidebar without a restart. The dupey scan walks only `scanned` places (Desktop, Documents, Downloads, cloud drives) — never the home folder or a whole disk. Rows are 28px with 12px labels and 14px glyphs. Automated checks: `test/places.test.ts`, `test/ui-places.test.ts`; on-device check (attaches and ejects a real disk image): `scripts/manual-qa/run-qa-finder-sidebar-places.mjs`.

**Indexing progress.** Above the 설정 row sits one block (`SidebarIndexActivity`, `src/renderer/src/components/`): headline (`인덱싱 중 1/3`), the percent, a 4px bar, and a detail line naming the phase or datasource that runs. Tones follow StatusDot's palette: accent while running, `--ok-dot` for done, `--error-orange-dot` for failure. A run's origin (`자동 새로 고침`, `앱 밖에서 실행`) goes in the tooltip and in Settings, not in the headline, which must fit in 159px. Done lingers 4 s, failure 15 s, then the block unmounts and the footer is the plain 설정 row again. It is a button that opens 설정 > 인덱싱 (`requestSettingsCategory`), where the same snapshot renders as the 진행 상황 card with one row per item. The snapshot is derived in the main process (`src/main/index-activity.ts`) from `refresh-progress.json` and `app-refresh/activity.json` and pushed on change over `indexActivity:changed`; the renderer never polls. Automated checks: `test/index-activity.test.ts`, `test/index-activity-view.test.ts`.

**A problem the last run left behind (issue #283).** The block above is the run's own snapshot and disappears with it, so what a failed or partial run leaves is kept separately and survives a relaunch: the main process owns the record (`src/main/index-problem-service.ts`, `window.autorag.indexProblem`), one window-wide subscription reads it (`hooks/useIndexProblem.ts`), and a pure mapping turns it into copy (`state/index-problem.ts`, `describeIndexProblem`). While a run is in flight the sidebar block stays exactly as described above; otherwise the problem takes its place — the same error tone, `sideTitle` over `sideDetail` — and stays until the index works again or the user dismisses it. The same record also draws one line above the file list (`components/IndexProblemBanner.tsx`, `role="alert"`, one accent button plus a `common.close` dismiss that hides it until a later run leaves a new problem) and the Settings > 인덱싱 진행 상황 card (인덱싱 멈춤 in the error tone, or 인덱싱 완료 with a skipped-files warning row) with the primary action, the quieter second one, and 닫기. A failure always outranks the skipped count; 임베딩 방식 바꾸기 leads only when the embedder itself refused and otherwise stays as the alternative, taking the user to the embedding choice on Settings > AI (`requestSettingsCategory("ai")`), while 다시 시도 / 이어서 받기 / 다시 확인 calls the bridge's retry; with `retrying` set, every surface shows 다시 시도하는 중이에요 and no buttons. The wording is the one agreed in `docs/prototypes/onboarding-failure` and lives under `indexProblem.*` in all four locale files. Checks: `test/index-problem-view.test.ts`, `test/ui-index-problem-banner.test.tsx`.

Instant Search's filename search ("전체" and "파일 이름") answers from the platform name index first, through `src/main/file-name-search.ts`: the user's `fsearch-cli` database on macOS/Linux (the same default database the FSearch app shares) and the bundled voidtools Everything on Windows. "파일 이름" narrows the index request to the folder in view before its result cap. When no index is installed or no database answers, the search falls back to the bounded disk walk over the `scanned` places. The app warms the index at launch — a `fsearch-cli watch` daemon on macOS/Linux, the Everything instance on Windows — and deliberately leaves it running across quits, because restarting a watch over a whole-machine database re-scans every monitored folder. Automated checks: `test/file-name-search.test.ts`, `test/fs-service.test.ts`; on-device check: `scripts/manual-qa/run-qa-finder-fsearch-search.mjs`.

### 1.5a Finder tags (macOS only)
The sidebar gains a **Tags** group, the row menu a colour-dot row plus a **Tags…** submenu, and rows a coloured dot. All three read and write the tags Finder itself uses; there is no app-private tag store. Windows and Linux show none of it (`FsTagCatalog.supported` is false and no `Tags` group renders) — the Windows design is tracked in #19.
- **Where tags live.** A file's tags are the extended attribute `com.apple.metadata:_kMDItemUserTags`, a binary plist array of `"<name>"` / `"<name>\n<N>"` (N = the label colour when the tag was assigned: 1 gray, 2 green, 3 purple, 4 blue, 5 yellow, 6 red, 7 orange). The colour Finder draws comes from its **registry** (`FinderTagDict` in the iCloud key-value store under `~/Library/Daemon Containers/*/Data/com.apple.kvs`), not from the file: a tag recoloured later keeps the old suffix on files that already carry it. The app draws the registry's colour and falls back to the file's suffix for a tag the registry does not list (`tagDotsOf`, `src/renderer/src/state/tags.ts`).
- **Sidebar.** The Tags group lists the tags Finder pins in its own sidebar, in Finder's order (the registry's `p` flag; `FavoriteTagNames` when the registry is unreadable; the seven colour tags on a Mac that never customized them). A row is the tag's colour dot and name; it opens `tag://<name>`, a virtual listing like Recents: real entries with their real paths, nothing created, pasted, dropped into, or watched there. The catalog is re-read when the window regains focus, because tags are created and recoloured in Finder and nothing signals it.
- **Row menu.** Between Services and the Trash group, as in Finder: one row of the seven colour dots (red, orange, yellow, green, blue, purple, gray) with a caption line under it, then a **Tags…** submenu of every tag Finder knows. Each dot is the tag Finder pins for that colour (a Mac that renamed Red to "Research" shows Research under the red dot; a colour with no pinned tag uses the OS's colour name), so a tag is one click away with no trip into the submenu. The dot under the pointer (or keyboard focus) grows to 125% and shows a white **+** in its centre, or a **−** when every selected row already carries the tag, so it is clear which tag a click will touch; a dot the selection already carries rests as a small check. The caption spells it out — `Add “Research”` or `Remove “Research”` — and reads "Tags" while the pointer is off the dots. A click toggles the tag on the whole selection and closes the menu; choosing a ticked tag removes it, any other state adds it to all (Finder's rule). The submenu stays for tags with no colour. The menu never shows tags in the Trash.
- **Row dots.** List, icon, and column views draw one dot per tag, overlapped like Finder's, with the tag names on the tooltip and accessible name. A tag with no colour is a hollow ring. Colours are `--tag-*` tokens (the values of `NSWorkspace.fileLabelColors`).
- **Writes.** `fs.setTags(paths, { add, remove })` reads each file's current array, changes only the named entries (the others keep their text, colour suffix included), and writes a binary plist with `xattr`, the way Finder does. `NSURLTagNamesKey` is not used: it stores `Red\n0` for the standard tags and a different suffix than Finder. Each path reports on its own (`FsBatchResult`); a path that cannot be tagged fails with the verbatim reason. The app does not create, rename, recolour, or delete a tag in Finder's registry — only Finder can.
- **Reads.** `tag://<name>` asks Spotlight (`mdfind 'kMDItemUserTags == "<name>"cd'`); it covers indexed volumes only. Spotlight trails a write by about 2 s, so the app overlays its own writes from the last 15 s on the answer: a tag view opened right after tagging is already right.

Automated checks: `test/finder-tags.test.ts`, `test/ui-tags.test.ts`, `test/finder-metadata.test.ts`. Agent tools for tags (search, create, delete, assign) are specified in Marker-Inc-Korea/AutoRAG#1830; this app does not call them.

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
| `⇧⌘T` | Window | Reopen the most recently closed folder tab (like a browser): same folder, back/forward history, selection and column chain, back in its old strip slot when it returns to the pane it left. Repeats through the last 20; Settings and AI Search tabs are not remembered |
| `⌘F` | Window | Focus Instant Search bar |
| `⌘L` | Window | Turn the path bar into a text field holding the current path. Enter goes there: a folder opens, a file opens its folder with the file selected; `~` expands to the home folder, pasted quotes and trailing separators are ignored, and a missing path toasts and stays. Escape or leaving the field cancels. Double-clicking the bar's empty part does the same |
| `⌘K` | Window | Show the nearest AI Search tab (or open one) and focus its composer |
| `Enter` | AI Search composer, search running | Steer the running search with the typed correction |
| `⌥Enter` | AI Search composer, search running | Queue the typed text as the next question |
| `Escape` | AI Search, search running | Stop the whole search |
| `⌘Z` | Finder | Undo the newest file operation (copy, move, duplicate, rename, New Folder / File, trash, Put Back, compress, extract); repeats back through the last 100 |
| `⇧⌘Z` | Finder | Redo the operation the last ⌘Z took back |
| `⇧⌘N` | Finder | New folder in the folder in view (inline rename starts at once) |
| `⌥⌘N` | Finder | New text file in the folder in view (inline rename starts at once) |
| `⌘R` | Finder | Inline rename of the single selected row (same state as the row menu's Rename) |
| `⌥↑` | Finder | Go up to the enclosing folder; the folder just left is selected and scrolled into view |
| `⌘D` | Finder | Duplicate the selected rows next to themselves (undoable with ⌘Z) |
| Mouse back / forward buttons | Window | Same as the toolbar's Back and Forward (the tab's history, also on Settings and AI Search tabs); a press at either end of the history does nothing |
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
  macOS share sheet, the image engine, and video container conversion
  (`ffmpeg`) are probed once per session. A missing engine removes the button
  instead of failing on click.
- **이미지 편집 → ○○로 변환** converts any image (HEIC/HEIF, JPEG, PNG, WebP,
  AVIF, GIF, TIFF, BMP) into every other format the machine can write, listed
  most common first: JPEG · PNG · WebP · HEIC · AVIF · GIF · TIFF · BMP, minus
  the source's own format. On macOS `sips` writes everything except WebP, and
  `sips --formats` decides which of them this macOS can write (AVIF is newer);
  WebP needs an `ffmpeg` that lists a WebP encoder. Elsewhere `ffmpeg` is the
  whole engine: its `-encoders`/`-muxers` lists gate each format (HEIC needs
  `libx265` + `heif`, AVIF an AV1 encoder + `avif`), and GIF gets a per-image
  palette. Resizing (최대 ○px) keeps the source format and is not offered for
  GIF, because both engines resize one frame and would drop an animation.
- **Adding an action** is two edits: one entry in `suggestedActions` (label,
  icon, and the `ActionRequest` it runs) and one `case` in
  `createActionService.run` (`src/main/action-service.ts`). The bar, the menu,
  the IPC channels, and the capability gating need no change.
- Action outputs never overwrite: `uniqueChild` numbers them Finder-style
  (`photo.jpeg`, `photo 2.jpeg`). Extraction offers every format the shared
  `archiveFormatOf` predicate recognizes — zip, tar, tar.gz/tgz, gz, 7z, rar, and
  tar.bz2/tar.xz — writing into a hidden staging folder beside the destination
  (removed on any failure) and then renaming it into place, flattening a single
  wrapper folder that matches the archive stem. Entry names are normalized to
  NFC before any path check (Mac tools store Hangul decomposed; Windows cannot
  match that against the composed name), and zip names written without the
  UTF-8 flag are recovered as UTF-8 or CP949, so a Korean Windows archive no
  longer extracts as `ÇÑ±Û.txt`. The wasm engine is a vendored rebuild with a
  UTF-8 locale (`scripts/libarchive-wasm/`); its licenses are
  recorded in `THIRD_PARTY_NOTICES.md`.
- Compression writes zip (default) or 7z — "7z로 압축" is a second row beside "압축"
  in the Inspector and context menu, a `compress` request with `format: "7z"`.
  The 7z writer (`src/main/sevenzip-writer.ts`) writes solid LZMA blocks (up to
  32 MiB each, so redundancy between files is shared): the LZMA encoder is
  WebAssembly (`lzma-wasm`) running in `src/main/lzma-worker.mjs`, so the main
  thread never blocks. A block whose sample does not shrink (jpg, mp4, zip)
  is stored as Copy rather than spending seconds in the encoder, and one file over
  256 MiB — beyond the wasm encoder's 32-bit memory — is deflated on its own.
  Entry names are written NFC. RAR is extract-only: the format is proprietary
  and RARLAB's license forbids building a compressor.

---

## 3a. First-run onboarding

- The reference is `docs/design-reference/onboarding/onboarding-prototype.html`.
  `src/renderer/styles/onboarding.css` ports its stylesheet rule for rule, with
  every selector scoped under `.onb` (the prototype's `.app-window`) and its
  keyframes renamed `onb-*`. Palette values the app already defines map onto
  app tokens (`--bg-window`, `--border`, `--text-*`, `--accent`), so appearance
  follows the app; the rest stay as `--onb-*` literals from the prototype.
- The React screens in `src/renderer/src/onboarding/` emit the prototype's DOM
  and class names, so the port needs no restyling. The prototype's drawn
  traffic lights are omitted: the real window's native ones sit over the 42px
  drag bar.
- The window opens at the prototype's 1120×720 canvas (min 960×680) and grows
  to the Finder size when onboarding completes.
- Prototype simulations are replaced by real state: the indexing screen shows
  real progress (no 30-minute minimum), folder cards show "세는 중…" until their
  pre-scan finishes, and a stopped index is the same screen held still (see
  below), never a dead end.
- **A first index that stops (issue #283)** is not a separate failure screen but
  the indexing screen paused: the scene stops, one amber light replaces the blue,
  and the screen carries only an icon, a one-line title, one reason line, one
  button (Enter presses it) and at most two quiet links. "Open Dazzi anyway" is
  always one of the links. The raw error and its code never appear (they stay in
  the app log); a stopped run shows no estimate, no phase strip and no locked
  gate. The reason decides the button: a refused embedder opens the embedding
  choice, an offline embedder or model download retries by itself (8 s, up to 6
  times, counted down on the reason line), an unplugged folder is watched every
  3 s and can be left out, a full disk resumes the download, anything else
  retries once and then offers the embedding choice. The design reference is
  `docs/prototypes/onboarding-failure/`; the reasons and their screens are
  `src/renderer/src/onboarding/pause.ts`.
- The design reference now includes an experimental **Smart Indexing** step between account and folder selection. It is intentionally synthetic: it shows a bounded discovery pass, broad include roots, nested exclude paths (including `~/Documents/Codex`), hidden-folder exclusion, editable recommendations, and the hand-off to the existing folder scope screen. It does not read the host filesystem, call an LLM, write `searchPaths`/`excludePaths`, or start indexing.
- The prototype controls can jump directly to each current-main-aligned step, switch light/dark appearance, and reset the synthetic state. The recommendation evidence and file counts are illustrative only; production model/provider, privacy consent, sampling limits, and path policy remain open design decisions.
- The reference is a standalone HTML demo; its hardcoded copy is not application runtime UI. Production implementation MUST use the existing i18n and onboarding bridge contracts rather than copying the demo state.
- Changes to these screens are checked against the prototype with
  `scripts/manual-qa/run-qa-onboarding.mjs`, which also writes per-step
  screenshots to `.omo/evidence/onboarding/`.

---

## 4. Verification & Testing Guardrails

- All UI components and behaviors are backed by automated tests:
  - Unit & contract tests via Vitest (`bun run test`).
  - Strict TypeScript validation (`bun run typecheck`).
  - Headless browser automation via Playwright verifying actual DOM bounding boxes, focus preservation, and animation lifecycle transitions.
