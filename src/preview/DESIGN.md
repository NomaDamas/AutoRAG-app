# Quick Look

Quick Look is a pre-warmed, reusable Electron `BrowserWindow`. The Finder
renderer sends the selected path to the main process; the main process reads
the file once and sends a sequenced document payload to the preview renderer.
The preview renderer reports the size of what it is about to show — an image's
decoded pixels, a PDF's first page, or the box a text/table/list viewer laid
out — and the main process fits the window to that size before showing it.

The window is the macOS Quick Look material: on macOS it is a transparent
window (`transparent: true`, `#00000000`) whose surface is the translucent
`--bg-quicklook-panel`, so the Finder stays visible behind it; other platforms
keep the opaque `--bg-chrome` fallback. Content without a measurable size (a
sandboxed iframe, or a read that has not finished within 250ms) gets a
page-shaped 880 × 1040 window instead. The OS draws the window's shadow; there
is no CSS elevation on the panel itself.

The toolbar is one row: close, the document glyph and filename, then fullscreen
and 열기 on the trailing side. The filename carries the kind and size in its
tooltip. The window is resizable and stays where the user put it: it re-centers
only when it has to (a new file, or a resize that would leave the screen).

## Open and close motion

Like Finder, Space grows the panel out of the file's icon and closing shrinks
it back into the icon, on an accelerating ease-in curve (120ms open, 100ms
close; instant under `prefers-reduced-motion`). The Finder sends the icon's
viewport rect with `show`/`hide`; the main process maps it to the screen
(`src/preview/shared/zoom.ts`). During the zoom the transparent window briefly
covers the icon and the panel together, ignores the mouse, and drops its
shadow; the page lays the panel out at its final size, pinned to the edges it
shares with that cover, and animates only a CSS transform, so the snap back to
the panel's own bounds is still. The page poses the panel before the window is
shown, so a full-size panel can never flash behind the growing one. A file
whose icon is not on screen (scrolled away, or an evidence source) zooms from
the panel's center. Non-macOS windows are opaque, so they show and hide without
the zoom.

## PDF

Pages render as one continuous column of paper cards inside the stage's single
scroll container — no pager, every page reachable by scrolling. Each page keeps
its paper-sized slot even while its canvas is released, so a long document
stays cheap: pages render while they are within 600px of the viewport and drop
their backing store once they leave. The frosted rail on the right
(`--bg-quicklook-frost` + `--backdrop-quicklook`) sits in its own gutter beside
the pages, never over them: a multi-page document reserves the rail's width
(plus its 12px insets) and the window grows by it. The rail lists every page, marks the
one nearest the top of the viewport, and jumps to a page on click. Each slot
takes its page's aspect ratio up front. Thumbnails observe the rail itself (it
is fixed-position, so the stage never sees them intersect), render once their
slot is within 400px of the rail's viewport, and keep their pixels afterwards.

Other viewers follow the same "natural size" rule: `pre` blocks, entry lists,
slide decks, and font samples are no longer stretched to the window, so a
three-line text file opens in a short window instead of a tall empty one.

## Keys and lifecycle

Quick Look is shown with `showInactive()` so the Finder list keeps keyboard
focus. Arrow Up/Down therefore move the Finder selection and retarget the
preview, and the wheel scrolls the preview itself. When the preview window
itself has focus, the main process intercepts Up/Down, Space, and Escape in
`before-input-event` and runs the equivalent action, so a focused `<video>`
whose native controls swallow those keys still closes and navigates.
Left/Right are left to the page, so a focused video can seek.

Media is cleared when the window hides, which stops playback. Video and audio
use native autoplay controls. Documents remain capped at 32MB; streamable
media and fonts use `autorag-preview://`, which answers `Range` requests with
`206 Partial Content`; Chromium only makes a video seekable when it does. HTML,
Markdown, and Word HTML render in sandboxed iframes with scripts disabled.

The implementation follows sigma-file-manager v1's useful performance pattern
(a hidden, reused preview window and native media elements) while keeping the
viewer registry and cross-platform custom protocol already used by this app.
