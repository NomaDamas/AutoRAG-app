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
  pixels until the new ones are drawn.
- **HWP / HWPX** — the same `PagedView`, drawn by rhwp (`@rhwp/core`, the
  Rust + WebAssembly engine alhangeul-macos builds on). rhwp parses HWP 5,
  HWPX, and some HWP 3 documents, paginates them when the file opens, and
  renders each page as SVG; a page shows as an `<img>` of that SVG, so the
  document can neither run script nor fetch anything. Hancom fonts fall back
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
- **HTML** — a sandboxed frame with scripts off, at desktop width, in a 390px
  phone column, or as highlighted source.
- **Code** — numbered lines on the paper material with the reference's Xcode
  palette (highlight.js, plus call and constant classes the grammars leave
  out), wrap and copy in the toolbar, and a footer with language, encoding
  (UTF-8, BOM, UTF-16, EUC-KR fallback), line ending, and line count. Only the
  first 512KB is highlighted; lines render in 400-line chunks as they scroll
  near.
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
- **iWork** — `.numbers`, `.pages`, and `.key` are ZIPs whose `preview.jpg` is
  the first sheet, page, or slide as the app drew it. Numbers and Pages show
  that image. A Keynote deck shows every slide in the PDF panel's `PagedView`:
  the show's slide order is recovered from the IWA container (snappy +
  protobuf) in `Index/Document.iwa` (`shared/iwork-slides.ts`), and each
  following slide is the app's own 356px `Data/st-*` render — the first slide
  keeps the full-quality `preview.jpg`, so the other cards are visibly lower
  resolution than the first. A deck whose order cannot be read (an older or
  newer format, or a corrupt file) falls back to the single first-page image
  with a warning. `byteNeed` is `extract`: the main process reads only the
  central directory, `Index/Document.iwa`, and the slide images
  (`node/iwork.ts`), so a large deck costs the same as a small one. A package
  without a page image (older directory-form files) gets the "Other" panel. The
  Finder's tile and Inspector thumbnails ask macOS Quick Look for the same
  extensions (`file-icon.ts`); Windows has no thumbnailer for them and shows
  the type icon.

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

Images, TIFF, HEIC, fonts, Word, sheets, slides, and EPUB keep their existing
viewers inside the new chrome.

## Reads

The main process reads only what the viewer will use (`byteNeed` in
`registry.ts`): nothing for media, PDF, images, and fonts, which stream through
`autorag-preview://` (it answers `Range` with `206`); the first 4MB of text,
code, Markdown, and HTML; whole documents (HWP included) up to 32MB; for iWork
packages the directory, the Keynote slide tree, and the page images inside; a
HEIC as the JPEG macOS's own `sips` decodes from it (`node/heic.ts`, about
0.2s on a 24MP iPhone photo even on a spinning disk; the viewer's wasm decoder
never finished one, and remains only where `sips` is absent or fails); and
a 64KB sniff of an unknown file, read on as text only when it looks like text.
The detail calls (details, SHA-256, folder size, audio tags) answer only for the
path the window is showing, and the hash and folder walk stop when the preview
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

Media is cleared when the window hides, which stops playback. Previewed pages
can never navigate the window or open new ones.
