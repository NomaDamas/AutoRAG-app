# In-app Quick Look

This folder is the whole preview surface. Finder code may open and close it.
It does not own viewers, file parsing, or the preview protocol.

The panel matches macOS Quick Look inside this app's light window: a floating
sheet, a centered filename, a kind and size line, a circular close button, and
an open button. It grows from the selected row and shrinks back. The app's
modal tokens (`--w-quicklook`, `--size-toolbar`, `--scrim-quicklook`,
`--shadow-window`, `--bg-chrome`) are reused. Two values are local because the
app tokens have no match:

| Token | Value | Why |
|---|---|---|
| `--ql-radius` | `16px` | Quick Look's rounded sheet, slightly rounder than `--radius-14` |
| `--ql-open` | `280ms` | Grow from the row; `--dur-modal` (200ms) is the generic overlay rise |
| `--ql-ease` | `cubic-bezier(0.16, 1, 0.3, 1)` | Ease-out that starts at the row and settles |

Motion is `transform` and `opacity` only. `prefers-reduced-motion: reduce`
fades opacity and does not move the panel. Escape closes Quick Look after
context menus and inline rename, and before clearing the search query.
Arrow keys move the previewed file while the panel stays open.

Bytes for documents stay under 32MB. Video, audio, images, PDF, and fonts
stream through `autorag-preview://` with HTTP ranges. HTML, Markdown, and
Word HTML render in a sandboxed iframe with scripts disabled.
