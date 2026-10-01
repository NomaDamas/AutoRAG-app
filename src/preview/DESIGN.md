# Quick Look

Quick Look is a pre-warmed, reusable Electron `BrowserWindow`. The Finder
renderer sends the selected path to the main process; the main process reads
the file once and sends a sequenced document payload to the preview renderer.
The preview renderer reports intrinsic image/video dimensions, allowing the
main process to fit the window before showing it.

The standalone window uses a Finder-like light toolbar: close and fullscreen
controls on the left, a centered filename and metadata line, and a default-app
open action on the right. The window is resizable, keeps media centered with
`object-fit: contain`, and uses a black stage for video.

Quick Look is shown with `showInactive()` so the Finder list keeps keyboard
focus. Arrow Up/Down therefore move the Finder selection and retarget the
preview. When the preview window itself has focus, its Up/Down, Space, and
Escape handlers send the equivalent action back through IPC. Left/Right do not
move the Finder selection.

Media is cleared when the window hides, which stops playback. Video and audio
use native autoplay controls. Documents remain capped at 32MB; streamable
media and fonts use `autorag-preview://` with HTTP range support. HTML,
Markdown, and Word HTML render in sandboxed iframes with scripts disabled.

The implementation follows sigma-file-manager v1's useful performance pattern
(a hidden, reused preview window and native media elements) while keeping the
viewer registry and cross-platform custom protocol already used by this app.
