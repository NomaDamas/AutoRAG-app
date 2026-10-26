# Quick Look

Quick Look is a pre-warmed, reusable Electron `BrowserWindow`. The Finder
renderer sends the selected path to the main process; the main process reads
only what the viewer needs and sends a sequenced payload to the preview
renderer. The preview renderer reports the size it wants and how to fit it,
and the main process fits the window to that before showing it.

The design follows the owner's quicklook-preview-reference prototypes
(2026-10-03): one panel per file type, all sharing the same chrome.
`scripts/manual-qa/run-qa-quick-look-reference.mjs` opens one fixture per
reference panel in the real app, in light and dark, checks the behaviour, and
captures the window for a side-by-side with the reference.

## Material and appearance

On macOS the window is transparent and carries the native `hud` vibrancy
material behind an 18px-radius panel tinted with `--ql-panel`;
CSS `backdrop-filter` cannot see past the window, so the blur is the OS's.
The material is switched off while the open/close zoom stretches the window
over the icon, and on again once it settles. `visualEffectState: "active"`
keeps the blur while the panel is shown without focus. Other platforms get an
opaque `--ql-panel-solid` window whose background follows `nativeTheme`.

Appearance is global. The persisted `AppSettings.appearance` value is applied
as Electron's `nativeTheme.themeSource` before either renderer is created, and
each preload mirrors it into `data-appearance` before first paint. Finder and
Quick Look therefore share one appearance policy; changing it in Settings
updates an open preview without reloading its file. The default is light and
the choice survives restart; there is no Quick Look-only setting. Media
controls keep one dark HUD material in both appearances, since they float over
the picture.

## Chrome

The 46px toolbar holds close and full screen (filled circular glyphs), the
file name, a slot where the viewer puts its own controls (segmented views,
wrap, copy), share (macOS only; the native share menu), and a pill
"Open with <app>". The default app name comes from Launch Services through
JavaScript for Automation, about 100ms, cached per extension and sent after
the load so it never delays the preview; Windows shows "Open".

Viewers reach the chrome through `ChromeProvider` (`src/preview/ui/chrome.tsx`):
`ToolbarSlot` portals controls into the toolbar, `report(size, fit)` asks for
the window size once per load, `resize(size)` follows a later user change (the
자세한 정보 disclosure), and `useHiddenTitle` leaves the toolbar title empty for
panels that print the name themselves.

## Sizing

`fitQuickLook` takes a fit mode. `aspect` scales media uniformly (images and
video report their decoded size). `clamp` keeps a panel's preferred width and
caps each side on its own, so a long file opens tall rather than narrow.
Panel sizes come from the reference: audio 620 × 368, other 620 × 290 (419
with details), folder 640 wide, code 840 wide, HTML 980 × 720, Markdown 1100
wide, and PDF and HWP the page width plus 56px margins and the 128px rail.
Text-like panels measure their content, not their scroller, because the window
still has the previous file's size when they lay out.

## Viewers

- **Video** — the picture on black with the reference's floating HUD: volume,
  ±15s, play, speed (1 → 1.25 → 1.5 → 2 → 0.5), loop, picture-in-picture, and
  a scrubber with elapsed and remaining time. Clicking the picture toggles
  playback; the HUD fades while playing and the pointer rests. ←/→ seek 5s.
- **Audio** — cover art (or a stand-in sleeve), title, artist, album, and time
  from the tags (`music-metadata`, read in the main process without a full
  scan), a 56-bar waveform decoded at 8kHz that doubles as a scrubber, stream
  facts, speed and repeat chips, a volume pill, and a transport bar whose last
  button continues in the default app. Files over 24MB skip the waveform.
- **PDF** — paper cards in one scrolling column, a floating pill with zoom
  steps and the current page, and a page rail (`PagedView` in `paged.tsx`).
  pdf.js streams the file over the range-capable protocol with auto-fetch off,
  so a large document opens on its first page. Pages keep their slot while
  released and render within 600px of the viewport; a zoom keeps the old
  pixels until the new ones are drawn. When opened from an AI Search evidence
  title (`anchor`), every page's text items are read once, the cited passage
  is located (`shared/locate.ts` + `shared/text-marks.ts`), and its boxes are
  drawn over the pages (`--ql-evidence-mark`) with the panel scrolled to the
  first match.
  An encrypted PDF opens a password prompt (`PasswordView`, `password.tsx`) instead
  of the Other panel: pdf.js reports `onPassword` (needed, then incorrect), the
  typed password goes straight back to it, and the pages draw in place once it
  accepts. The password lives only in that component's state and is asked again
  on the next preview.
- **HWP / HWPX** — the same `PagedView`, drawn by rhwp (`@rhwp/core`, the
  Rust + WebAssembly engine alhangeul-macos builds on). rhwp parses HWP 5,
  HWPX, and some HWP 3 documents, paginates them when the file opens, and
  renders each page as SVG; a page shows as an `<img>` of that SVG, so the
  document can neither run script nor fetch anything. With an `anchor` (AI
  Search evidence) each page's `getPageTextLayout` runs (with exact
  per-character `charX` edges) feed the same `locateMarks` overlay and scroll
  as PDF. Hancom fonts fall back
  to rhwp's chain (Batang, Malgun Gothic, Apple SD Gothic Neo, Noto, serif /
  sans-serif). rhwp's glue and its 10MB module are a lazy chunk loaded on the
  first HWP preview, which is why both renderer CSPs allow
  `'wasm-unsafe-eval'`. Every rhwp use goes through `shared/hwp.ts`, and the
  dev server serves `@rhwp/core` unoptimized (`electron.vite.config.ts`): an
  optimized copy carries a `?v=` hash the long-lived Quick Look window would
  keep importing after a re-optimize. The Finder Info panel's preview paper
  shows the same first page (`ui/rhwp.ts`), since the OS thumbnailers draw
  nothing for HWP without Hancom's plug-in. Encrypted, DRM, and unsupported
  files fall back to the Other panel with rhwp's message.
- **Word 97-2003 / PowerPoint 97-2003** (`.doc` `.dot` · `.ppt` `.pps` `.pot`)
  — on macOS, the page the OS itself draws: `node/office-render.ts` runs
  `qlmanage -p` (Office.qlgenerator: fonts, colours, tables, every slide,
  shapes, pictures; about 0.1s for a document, 1.3s for a 26-slide deck) into a
  temp folder, `sips` rasterizes the vector art it writes as PDF (at 3x the drawn
  size), and `standaloneOfficeHtml` inlines every picture and strips scripts,
  frames, links, remote pictures, and event handlers, adding a CSP of
  `default-src 'none'; img-src data:`. The result travels as
  `PreviewDocument.rendered` and shows in a `sandbox=""` frame loaded from a
  **blob URL, not `srcdoc`**: the generator writes unitless lengths
  (`width: 720`) that only quirks mode honours, and an `srcdoc` document is
  never quirks mode, so every slide collapsed to nothing. The window takes the
  generator's own viewport width (595 for a Word page plus margin room, 720
  for a slide). A Page · Text switch in the toolbar flips to the extracted text.
  **Time to first content**: the OS takes 0.1-0.7s to draw the page (2-5s when
  its preview service has been idle) and up to 0.4s more to rasterize pictures,
  so the page is never waited for. Selecting a file starts the render
  (`prefetch` channel; one at a time, only the newest queued file is kept) and
  the OS first-page thumbnail (tens of ms, the same icon provider the Finder
  tiles use). Space then opens in one tick with what is known: a finished page,
  or the cached first-page image, with the whole page pushed on the `office`
  channel when it lands; the image is removed only once the frame has loaded
  and the frame stays transparent until then, so the panel never blanks. A
  generic type icon (what the OS returns for a file it cannot draw: an
  all-transparent corner) is rejected, and the text view shows meanwhile.
  Pages are cached by path + mtime + size (96MB, least recently used out).
  Pictures are rasterized at 3x their own drawn width, grouped by power-of-two
  width into a few parallel `sips` runs: one 2048px run for all of them cost 3.3s
  on a 26-slide deck, a run per distinct width cost 35 process starts.
  The generator refuses files it cannot read (minimal or non-Word streams): the
  panel then shows the extracted text alone, without the switch.
  Everywhere else, and as that fallback, `shared/legacy-office.ts` reads the
  compound-file container itself (bounds-checked typed arrays; a general CFB
  library turned a 32MB file into a 1.2GB array of numbers) and pulls only the
  streams it needs.
  Word: the piece table (Clx) in `0Table`/`1Table` gives the main document's
  UTF-16 and cp1252 pieces; fields keep their result and drop the instruction,
  cell marks become tab-separated rows, a form feed starts a new page card;
  footnote/header stories after the main text are not shown. PowerPoint: `Current User` →
  UserEditAtom chain → persist directory finds the newest copy of every slide
  (a fast save leaves stale ones behind), and each slide shows its title and
  text lines in show order, merged with the placeholder text the slide list
  keeps. Macros, OLE objects, and links are never opened. Encrypted, Word 6/95,
  empty, damaged, and non-Word files fall back to the Other panel with a note;
  an RTF or OOXML file saved under the old extension is handed to the RTF /
  `.docx` / `.pptx` viewer by its first bytes. The Finder tile uses the OS
  first-page thumbnail (`.doc .dot .ppt .pps .pot .xls .xlt`; measured 0.3-0.6s
  cold, none empty), unlike `.docx`/`.xlsx`/`.pptx`, which stay letter tiles.
- **HTML** — a sandboxed frame with scripts off, at desktop width, in a 390px
  phone column, or as highlighted source.
- **Apple locations, archives, clippings, and packages** — `.webloc` and
  `.inetloc` show an inert title and URL; the existing Open action hands the
  pointer to the OS. `.webarchive` is parsed in-process (XML or binary plist),
  its archived images and style sheets are inlined, and `standaloneOfficeHtml`
  plus a `sandbox=""` frame removes or blocks scripts, event handlers,
  navigation directives, frames, and every network fetch. `.textclipping`
  accepts plist, plain UTF-8, and classic `TEXT`/`utf8`/`utxt` resource forks.
  `.rtfd` renders `TXT.rtf` through the RTF text converter and lists attachments
  without opening them; `.iconset` draws its PNGs as a grid. These directory
  packages, plus `.pvt`, `.lpdf`, and `.prefpane`, are file rows rather than
  folders to browse into. The latter three and `.pict`/`.pct`/`.pic`/
  `.pictclipping` use macOS Quick Look thumbnails in the Other panel and keep
  the ordinary information panel on other platforms.
- **Code** — numbered lines on the paper material with the reference's Xcode
  palette (highlight.js, plus call and constant classes the grammars leave
  out), wrap and copy in the toolbar, and a footer with language, encoding
  (UTF-8, BOM, UTF-16, EUC-KR fallback), line ending, and line count. Only the
  first 512KB is highlighted; lines render in 400-line chunks as they scroll
  near. With an `anchor` (AI Search evidence) `locateLines` marks the cited
  source lines (`.ql-line--marked`), renders their chunk up front however far
  down the file it is, and scrolls to the first marked line; the footer carries
  the found/missing note. The Markdown source pane takes the same marks, and
  the rendered page paints the cited passage through the CSS Highlight API
  (`dom-marks.ts`, `::highlight(ql-evidence)`), matching the shared locator
  against the page's text nodes, and scrolls to it.
- **Markdown** — coloured source and the rendered page side by side (원본 ·
  나란히 · 렌더링), with a footer counting lines, words, headings, tables, and
  code blocks. Raw HTML in Markdown is reduced to an allowlist in an inert
  document (`markdown-html.ts`); relative images load through the preview
  protocol and remote ones are dropped, so the preview never reaches the
  network.
- **Email, contacts, calendar** — `eml`, `emlx`, `msg`, `mbox`, `vcf`, `ics`,
  parsed in `shared/mail.ts`, `msg.ts`, `vcf.ts`, `ics.ts` and drawn by
  `ui/mail.tsx`, `contact.tsx`, `calendar.tsx`. Mail shows From, To, Cc, Date
  (RFC 2047 words and RFC 2231 parameters decoded), the body, and an attachment
  list (name, type, size; attachments are counted, never decoded). Quoted-
  printable and base64 bodies decode in the declared charset; EUC-KR, CP949, and
  `ks_c_5601-1987` map to Chromium's `euc-kr`, and an unlabelled or mislabelled
  8-bit body falls back to strict UTF-8, then EUC-KR. A message with both bodies
  opens rendered, with a 렌더링 · 텍스트 toggle. HTML goes through the Markdown
  allowlist (`ui/mail-html.ts` over `markdown-html.ts`) with no base folder:
  scripts, frames, forms, and every remote or relative image are dropped, and a
  `cid:` image becomes a data URI only when it is a base64 PNG, JPEG, GIF, or
  WebP under 512KB. `mbox` is read as a 4MB prefix: messages are counted with a
  byte scan, the first 200 are listed, and the count reads "이상" (at least) when
  the file was cut. `msg` is an OLE2 compound file, so it is read whole and
  parsed with `cfb` (Apache-2.0); subject `0037`, sender `0C1A`/`0C1F`/`5D01`,
  recipients `0E04`/`0E03`, body `1000`, HTML `1013`, and attachments from
  `__attach_version1.0_#N`. `vcf` shows one card per contact, with the photo as
  a data URI when it is PNG, JPEG, GIF, or WebP (SVG and remote photos are
  dropped). `ics` lists events with start, end, time zone, location,
  description, and a recurrence summary; times show as written in the file,
  never converted.
- **Other** — a large page glyph labelled with the extension, the name, kind,
  size, and date, and a 자세한 정보 disclosure with creation date, location,
  SHA-256, and what a binary is (PE, Mach-O, ELF platform; UDIF disk images).
- **Folder** — Space previews folders too. The folder glyph, item count, size
  (a bounded walk: 200k entries or 2.5s, then a lower bound marked `+`), date,
  and the six most recently modified children.
- **Application bundle** — a macOS `.app` is a directory but the OS opens it as
  one app, so Space previews the app, not its contents: the app's own icon
  (the provider's 640px preview tier — the same `autorag-thumb://` lane the
  Inspector paper uses), the name, "Application", the bundle's total size (the
  same bounded walk the folder panel runs), and the date. `Contents/` is never
  listed, and the toolbar button stays "Open" because the bundle itself is what
  opens. The classification lives in `node/bundle.ts` + `node/window.ts`; the
  panel is `ui/bundle.tsx`.

- **Archive** — ZIP, tar, and gzip files read like a folder: the same header
  (page glyph, name, kind, "N items, size", date) and the same "포함된 항목"
  strip, built from the archive's top level (`shared/archive-items.ts`): entries
  group under their first path segment, dot entries and `__MACOSX` are hidden,
  and each child is as new as its newest member. Both panels draw the strip
  with `ui/contents.tsx`, so they stay identical. A gzip of one text file shows
  the text instead.
- **Archive listing (main process)** — `.7z`, `.rar`, `.tar.bz2`/`.tbz2`/`.tbz`,
  `.tar.xz`/`.txz`, `.tar.zst`/`.tzst`, `.iso`, `.deb`, `.rpm`, and `.cab` need
  an engine the page does not have (`archiveList` viewer, `byteNeed` `query`).
  `preview:archive` runs `src/main/archive-list.ts`, which reads the file on a
  worker thread (`archive-list-worker.mjs`, the libarchive wasm build the
  extractor uses, header scan only — no member data is read) and answers with
  one entry per top-level child (`collapseToTopLevel`), so the page draws the
  same panel as a zip through `summarizeArchive`. The wrappers libarchive cannot
  open are undone in the worker: a `.deb`'s `data.tar.*` member, an `.rpm`'s
  payload after its lead and two headers, and any zstd layer (Node's `zlib`).
  RAR is listed, never extracted. The listing is bounded: an archive over 256MB
  is not read, a zstd layer stops at 512MB, a listing stops at 100,000 entries or
  30s. A password-protected, damaged, or over-limit archive keeps the info panel
  and says why (`quickLook.archive.unreadable.*`). `.dmg`, `.pkg`, and `.lz4`
  have no reader and keep the info panel.
- **iWork** — `.numbers`, `.pages`, and `.key` are ZIPs whose `preview.jpg` is
  the first sheet, page, or slide as the app drew it. Numbers and Pages show
  that image. A Keynote deck shows every slide in the PDF panel's `PagedView`:
  the show's slide order is recovered from the IWA container (snappy +
  protobuf) in `Index/Document.iwa` (`shared/iwork-slides.ts`), and each
  following slide is the app's own 356px `Data/st-*` render — the first slide
  keeps the full-quality `preview.jpg`, so until the full-size upgrade below
  lands (or when it cannot run) the other cards are visibly lower resolution. A deck whose order cannot be read (an older or
  newer format, or a corrupt file) falls back to the single first-page image
  with a warning. `byteNeed` is `extract`: the main process reads only the
  central directory, `Index/Document.iwa`, and the slide images
  (`node/iwork.ts`), so a large deck costs the same as a small one. A package
  without a page image (older directory-form files) gets the "Other" panel. The
  Finder's tile and Inspector thumbnails ask macOS Quick Look for the same
  extensions (`file-icon.ts`); Windows has no thumbnailer for them and shows
  the type icon.

  **Full-size slides (macOS)** — the package holds no larger per-slide image,
  so the panel asks the OS for one the way Finder's preview pane gets it:
  macOS's own iWork Quick Look generator (`node/keynote-render.ts`,
  `withKeynote` in `node/window.ts`). `qlmanage -p -o` writes one
  full-resolution vector PDF per slide plus a `Preview.html` that lists them in
  show order (the PDFs are named by creation order, so only the page gives the
  order; about 2s for 16 slides, 9s for 140), and `sips` rasterizes them to
  JPEG at their native size (1920x1080 for 16:9), 8 slides per run and 4 runs
  at once so the top of the deck comes first. No Keynote app is launched and no
  document is opened. The panel opens at once on the stored slides with
  `PreviewDocument.slidesRendering` true (a "Sharpening slides…" badge over the
  paged view). The export folder is watched while it is written (a JPEG counts
  once its end marker is on disk) and each finished slide goes out on the
  `slides` channel with its index. The pictures arrive in a burst, so the window
  paces them (`ui/slide-sweep.ts`): top to bottom, at most one step per 60ms
  and at most 20 steps per burst, so the deck sharpens from the top instead of
  flipping at once; the badge ends after the last slide. `PagedView` redraws
  only a card whose `revisions` entry changed, swapping the picture in place
  once drawn. A deck whose slide count differs from the slide tree's (a hidden
  slide, an unreadable file) keeps the stored slides. The result is kept per
  deck version (path + mtime + size) under `<userData>/keynote-slides`, a 1GB
  LRU, so an unchanged deck is not drawn again. Exports run one at a time. A
  deck Quick Look fails on keeps the stored slides and is not retried until it
  changes or the app restarts. On other systems nothing changes.
- **Google Drive documents** — `.gdoc`, `.gsheet`, `.gslides`, `.gform` (and
  `.gdraw`, `.gmap`, `.gsite`, `.gjam`, `.gtable`, `.gscript`) are the ~170 byte
  JSON pointers Drive for desktop shows instead of a cloud-only document
  (`shared/google-drive.ts`: `doc_id`, `email`). The content is not on disk, so
  the only picture is the thumbnail Drive's file provider draws for the OS:
  the listing tile, the Inspector paper and the panel all ask the OS
  thumbnailer for it (`file-icon.ts`), and the panel's main process attaches it
  as `PreviewDocument.thumbnail` (`node/google-drive.ts`: the cached tier an
  earlier selection made, else a fresh one, given up on after 2 s so Space never
  waits on the network). The `gdrive` viewer is the "Other" panel with that
  picture in place of the page glyph and "Google account: <email>" as its note;
  the toolbar's Open hands the pointer to Drive, which opens the document in
  the browser. Drive supplies a 128px square whatever size is asked, so the
  Inspector and panel show it enlarged. Where Drive has drawn nothing the OS
  type icon (macOS) or the page glyph stays.

- **Databases and data files** — `.sqlite`, `.sqlite3`, `.db`, and `.parquet`
  (`data` viewer, `byteNeed` `query`) send no file bytes to the page. The
  `preview:data` call opens the file in the main process (`node/data.ts`) and
  returns capped rows: 100 rows, 50 columns, 200 characters per cell, and row
  counts that stop at 100,000. SQLite opens `mode=ro&immutable=1` with
  `trusted_schema=off`, so no lock is taken and no `-wal`/`-shm` file is
  created or touched; the cost is that commits still in a `-wal` file are not
  shown, and the footer says so. Views are listed but never run (their stored
  query is arbitrary), and no user SQL exists. A file without the SQLite header
  (including an encrypted database) or that fails to open gets a note in the
  "Other" panel. Parquet reads the footer and the first row group only (a group
  over 64MB is not decoded); `PARE` (encrypted footer) is named as such.
  `.jsonl`/`.ndjson` use the text view with the first 2,000 records
  pretty-printed (`shared/jsonl.ts`); `.plist` shows XML, converting `bplist00`
  in `shared/plist.ts` to the text `plutil -convert xml1` writes.
- **OpenDocument** — `.odt`, `.odp`, `.odg`, and `.ods` are ZIPs whose
  `Thumbnails/thumbnail.png` is the first page, slide, or sheet. `.odt` is
  modelled from `content.xml`/`styles.xml` (`shared/odt-model.ts`,
  `shared/odf-blocks.ts`: headings, styled runs, lists, tables, inline
  pictures) and drawn as inert DOM on a white page column
  (`shared/odf-render.ts`, `ui/odf.tsx`). `.odp` is modelled per `draw:page`
  (`shared/odp-model.ts`: master-page shapes, backgrounds, text boxes, pictures,
  rect/ellipse/line shapes) and drawn in the PDF panel's `PagedView` like a
  `.pptx`. `.odg` has no text model: `byteNeed` is `extract`, the main process
  reads the central directory and that one entry (`node/odf.ts` over the shared
  ranged reader `node/zip-read.ts`) and shows the PNG. `.ods` stays in the
  spreadsheet viewer. Only `#rrggbb` colours and numeric lengths reach style
  attributes, and picture references that are absolute, remote, or contain `..`
  are dropped. The Finder's tile and Inspector thumbnails for all four come from
  the same embedded PNG on every platform (`file-icon.ts`), since Quick Look
  has no ODF thumbnailer. A package with no `Thumbnails/thumbnail.png` (one
  written by a tool rather than by LibreOffice) keeps the type icon. `.potx`
  tiles use the JPEG under `docProps/thumbnail.jpeg`, re-encoded to PNG for
  the icon cache; `.pptx` tiles still come from Quick Look.

- **PowerPoint** — `.pptx`, `.pptm`, `.ppsx`, and `.potx` share the PDF panel's paged
  layout: every slide is a paper card in one scrolling column with the page
  rail, the `1 / N` pill, and zoom. `shared/pptx-model.ts` reads the OOXML
  from the whole-file bytes — slide order from `p:sldIdLst` through the
  presentation relationships (never a filename sort), each slide's background,
  and its shapes in z-order: `p:sp` (geometry, solid fill, line, and text with
  per-run size, bold, italic, underline, colour, alignment, and basic bullets),
  `p:pic` (image plus `a:srcRect` crop), `p:grpSp` (child-coordinate
  transforms), and `p:graphicFrame` tables. Position and text defaults for
  placeholder shapes inherit from the slide layout, then the slide master
  (`p:txStyles`); colours resolve through the theme (`srgbClr`, `schemeClr`
  with basic `lumMod`/`lumOff`/`tint`/`shade`, `sysClr`). `shared/pptx-render.ts`
  draws the model as an absolutely positioned DOM tree at the slide's natural
  pixel size (EMU ÷ 9525) — real selectable text, never a canvas — and
  `ui/pptx.tsx` CSS-scales it per slot, inflating a slide's pictures from the
  zip only when that page or thumbnail is drawn and revoking their blob URLs
  when it is released. Charts, SmartArt, media, and unsupported picture formats
  (SVG, EMF, WMF) draw a labelled placeholder instead of crashing; a malformed
  slide draws an error card while the rest of the deck still renders, and a
  package whose presentation cannot be read falls back to the Other panel.
  Known fidelity gaps: no gradients, pictures, patterns, or theme-fill
  backgrounds (a solid colour is used instead); autofit, line spacing, and
  exact bullet indents are approximated; 3D, shadows, soft edges, and
  connectors with arrowheads are ignored; embedded fonts are not loaded, so
  text uses the run's typeface with an Apple SD Gothic Neo / Malgun Gothic /
  Noto Sans KR fallback (Korean renders through that chain); SmartArt and
  charts are labelled boxes rather than their rendered previews.

- **Spreadsheets** — `.xlsx`, `.xlsm`, `.xlsb`, `.xls`, `.xlt`, `.ods`, `.csv`, `.tsv`
  show the first 100 non-blank rows and 20 columns as a table, with a pager
  between sheets. The viewer reads no more than it draws (`shared/sheet.ts`):
  a workbook container gets a names-only pass and then one pass for the shown
  sheet, each stopping after 1000 rows; a delimited text file is read in one
  pass with the same stop. Measured in the built app on an M4 Max, a 12MB
  workbook of three 60,000-row sheets went from 7.9s to 0.75s to first rows and
  a 28MB csv from 5.5s to 0.29s; the page used to be unresponsive for the whole
  wait. The parse is memoised per file and sheet, so a re-render does not read
  the workbook again. `run-qa-quick-look-sheet-large.mjs` drives this on the
  production build.

- **TIFF** — on macOS the main process has the OS decode the file (`sips`, shared
  with HEIC in `node/sips.ts`) and the panel shows the resulting PNG. A picture
  longer than 2048px on its long side is shrunk to that; a smaller one is left
  at its own size, because sips's resize option scales up as readily as down
  (a 8px TIFF came back 2048px wide). Elsewhere the page's own decoder (UTIF)
  runs, which decodes synchronously on the page's only thread, so a TIFF over
  8MB arrives without bytes and the panel shows the file's info instead of
  freezing. Measured in the built app on an M4 Max, a 21MB scan went from a
  median 3.8s to 0.26s (the old decoder ranged 0.4-7.3s run to run), and a
  35MB TIFF, past the old 32MB whole-file cap and never shown, opens in 0.27s.
  `run-qa-quick-look-tiff.mjs` drives this on the production build.

Images, TIFF, HEIC, fonts, Word, sheets, slides, and EPUB keep their existing
viewers inside the new chrome.

## Reads

The main process reads only what the viewer will use (`byteNeed` in
`registry.ts`): nothing for media, PDF, images, and fonts, which stream through
`autorag-preview://` (it answers `Range` with `206`); the first 4MB of text,
code, Markdown, and HTML; whole documents (HWP and legacy Office included) up to 32MB; for iWork
packages the directory, the Keynote slide tree, and the page images inside; a
HEIC as the JPEG macOS's own `sips` decodes from it (`node/heic.ts`, about
0.2s on a 24MP iPhone photo even on a spinning disk; the viewer's wasm decoder
never finished one, and remains only where `sips` is absent or fails); and
a 64KB sniff of an unknown file, read on as text only when it looks like text.
The detail calls (details, SHA-256, folder size, audio tags, data rows, archive listings) answer only for the
path the window is showing, and the hash, folder walk, and archive listing stop when the preview
moves on.

Electron honours only one `registerSchemesAsPrivileged` call, so the preview
and thumbnail schemes register together in `src/main/index.ts`.

## Open and close motion

Like Finder, Space grows the panel out of the file's icon and closing shrinks
it back into the icon. The curve is an Apple spring, not a hand-tuned bezier:
`src/preview/ui/zoom-motion.ts` states Apple's `response`/`dampingFraction`
parameters and `spring-easing` turns them into a CSS `linear()` easing that the
Web Animation API plays on the panel (180ms open, 150ms close, tail included;
instant under `prefers-reduced-motion`). The Finder sends the icon's viewport
rect with `show`/`hide`; the main process maps it to the screen
(`src/preview/shared/zoom.ts`). During the zoom the transparent window briefly
covers the icon and the panel together, ignores the mouse, and drops its
shadow and material; the page lays the panel out at its final size, pinned to
the edges it shares with that cover, and animates only a CSS transform. A file
whose icon is not on screen zooms from the panel's center. Non-macOS windows
are opaque, so they show and hide without the zoom.

## Keys and lifecycle

Quick Look is shown with `showInactive()` so the Finder list keeps keyboard
focus. Arrow Up/Down move the Finder selection and retarget the preview.
When the preview window itself has focus, the main process intercepts Up/Down,
Space, and Escape in `before-input-event`, so a focused control still closes
and navigates. Left/Right stay with the page, where media seeks.

A text field in the page (the PDF password prompt) reports focus through
`bridge.textEntry`. While it has focus, the main process keeps the field's
Space and Up/Down out of the shortcuts (`quickLookKeyAction(input, typing)`);
Escape still closes. The panel opens without focus, so the report also focuses
the preview window; closing hands focus back to the Finder (`hide`).

An evidence title in the right sidebar opens the panel with no Finder row to
toggle, and the title button keeps focus. The Finder's keydown handler
(`useFinderKeyboard`) therefore closes an open preview on a plain Space first,
before its button and AI Search tab filters, unless the target is a text field.

Media is cleared when the window hides, which stops playback. Previewed pages
can never navigate the window or open new ones.
