# AutoRAG

AutoRAG is a standalone Electron + React desktop app — a Finder-style file
browser with grounded AI assistance — built on the public AutoRAG librarian.
Internal identifiers such as `@autorag/librarian`, `@autorag/app`,
`AutoRAGAgent`, and the shared AutoRAG config are unchanged.

## Prerequisites

- Bun
- Node.js 24+
- Rust and `dupey` (`cargo install dupey --locked`)

The librarian is not vendored and is never read from a sibling checkout. Before
install, development, tests, typechecking, or builds, the lifecycle scripts
clone or fast-forward `.upstream/autorag` to `origin/main`, install its
dependencies, and build its `dist` output. The sync prints the exact upstream
HEAD used by the app. It only uses the public GitHub repository; corpus files
and secrets stay local.

## Commands

From a fresh clone, run `make setup` once: it verifies the toolchain (bun,
Node 24+, dupey), installs dependencies, and makes the checkout ready for
development. It is idempotent, so re-running it is always safe.

```sh
make setup
make run
bun run test
bun run typecheck
bun run build
```

Equivalent manual commands (what `make setup` wraps):

```sh
bun install --frozen-lockfile
node scripts/ensure-electron.mjs
bun run dev
```

`make run` also works from a fresh clone on its own: it runs a fast `--ensure`
preflight that installs dependencies only when `node_modules` is missing, then
launches the app. Run `make setup` explicitly when you want the toolchain
checks (a missing `dupey` fails loudly there instead of at launch).

`make run` starts the dev app on free ports with debugging enabled: it picks
unused ports for the renderer dev server, the main-process V8 inspector
(`chrome://inspect`), and the renderer remote-debugging endpoint, and prints
all three before launching. It goes through `bun run dev`, so the `predev`
hooks fast-forward the librarian to `origin/main` and rebuild it first: the
window always runs the latest version.

Set `AUTORAG_SKIP_DUPEY_CHECK=1` only when intentionally testing without
version-family support. Use `PORT=9234 bun run dev` to select the Vite port.

### Appearance

Settings → General → Appearance controls the entire app with `Light` or `Dark`.
The same persisted choice drives Finder, Settings, AI surfaces, and Quick Look
through Electron's native theme; Quick Look has no separate appearance switch.
The default is Light, and changing it while Quick Look is open updates the panel
without reloading the previewed file. The choice is retained after restart.

### Quick Look

Space previews the selected file in its own panel (`src/preview/DESIGN.md`).
HWP and HWPX documents open like a PDF: page-accurate paper cards, zoom, and a
page rail, drawn locally by [rhwp](https://github.com/edwardkim/rhwp)
(`@rhwp/core`, MIT) on macOS and Windows alike; the Info panel's preview paper
shows their first page. Nothing is uploaded; Hancom Office is not required.

### AutoRAG configuration settings

Settings writes to the shared AutoRAG `config.json`; the Finder does not keep a
second datasource or model configuration. The categories are:

- **General** — document languages and app preferences.
- **LLM Models** — provider/model catalog selection, provider endpoint, allowed
  API protocol, and encrypted provider credentials. Runtime capabilities and token
  limits come from the provider catalog or model runtime.
- **Embedding Models** — local MinSync profiles or loopback endpoints, automatic
  model dimensions, request controls, and reindexing warnings.
- **Reranker Models** — the v2.7 OpenRouter reranker, wire model, Top N,
  timeout, and encrypted credentials. Other reranker providers are not offered
  because the upstream resolver rejects them.
- **Data Sources** — the management view for adding named connections per
  datasource template. A separate **Data Sources** sidebar group exposes one
  direct Settings tab per configured connection (for example Discord, KakaoTalk,
  iCloud Drive, mailcrawl, Slack, or Spotlight), so connector fields are not
  nested inside one crowded page.
- **Deep Indexing / Light Indexing / Other Apps** — search paths, MinSync,
  Jikji, platform-detected FSearch/Everything, web search, parser/OCR, dupey,
  datasource access, and exclusions. Installer paths, retrieval limits, P2P,
  and code-folder quick exclusions stay on AutoRAG defaults and are not exposed.

Ordinary datasource, indexing, model, and app-option edits apply automatically
after validation. Embedding identity changes remain explicit because they require
a full MinSync reindex; the identity is saved separately and Settings keeps the
reindex warning until an explicit refresh succeeds. API credentials remain
explicit encrypted-store actions.

The parser and OCR language controls are multi-select fields backed by the
upstream-supported tags (`ko`, `en`, `ja`, `zh-hans`, `zh-hant`, `fr`, `de`,
`es`, `ru`, `it`, `pt`, `vi`, `th`, `ar`, `hi`). OCR stores the corresponding
Tesseract traineddata codes while displaying the AutoRAG language tags.
The Deep, Light, and Other Apps panels use typed controls for the supported
user-adjustable fields instead of raw JSON textareas; leaf saves preserve
unrelated config keys and reset removes the edited leaf so AutoRAG defaults apply
again. Installer paths, retrieval limits, P2P, and code-folder quick exclusions
remain AutoRAG-owned defaults and are not exposed in Settings. The Light Indexing
panel renders only the backend detected for the current operating system.

API keys are never written into `config.json`. The app uses Electron's encrypted
credential store and injects the selected environment variable into the live
agent process. Remote embedding endpoints and datasource embedding/rerank
endpoints are rejected; use a loopback service for corpus-bearing requests.

The Settings tab is an app-owned UI location, not a filesystem path; it never
issues directory listings, incremental reads, or watcher requests. Returning to
a Finder tab restores its existing folder listing and watch set.

## Filesystem worker

Folder listings, incremental reads, Finder metadata, OS kinds, the sidebar
places, the dupey scan, the index badges, and the native watcher run in one
Electron utility process, "AutoRAG File System" (`src/fs-worker/`), not on the
main process. The renderer talks to it over a `MessagePort` the main process
hands the preload (`src/preload/worker-link.ts`); main only brokers ports and
owns the process lifecycle (`src/main/fs-worker-host.ts`). Main keeps what
only Electron's main process can do and the worker asks for over its host
port: thumbnails and file icons (`nativeImage`, `app.getFileIcon`), the Trash,
opening files and URLs, and the clipboard.

If the worker dies, main forks a new one at once (repeated crashes within 10 s
back off, up to 5 s), the window stays, and every open tab relists and
re-watches its folders. Unanswered reads are re-sent to the new worker; a
request that changes files (copy, move, rename, trash, restore from the Trash,
emptying the Trash, create, undo, eject) is never re-sent and fails with a
message asking the user to check the result.
Quitting asks the worker to release its watches and waits up to 2 s before
exiting. QA lane: `scripts/manual-qa/run-qa-finder-fs-worker-crash.mjs`
(SIGKILLs the worker twice and checks the tabs recover within 5 s).

## Live filesystem sync

Folders shown in open tabs are watched for changes made by other apps. A
created, deleted, renamed, or edited file appears in the tab without clicking
anything. Ordinary direct-child changes are applied incrementally: the fs
worker re-reads only the changed paths and the renderer patches those rows.
An event overflow, a recreated watched root, or a missing-path recovery falls
back to a full relist. Only real folders in open tabs are watched: Recents and
datasource virtual paths never are. Watching uses
`@parcel/watcher`; symlinked folders are canonicalized for native events and
mapped back to the path shown in the tab. Events are coalesced per directory
with a 150 ms trailing debounce and a 1 s maximum wait. Closing a tab,
navigating away, reloading the window, or quitting releases the watches. Set
`AUTORAG_FS_WATCH_DIAG=1` to log watch, unwatch, and batch diagnostics.

All live traffic flows through one serial `ChangeHub` queue in the fs worker
process. For each batch, every registered derived layer reconciles first, with
a 750 ms per-layer timeout, and only then does the hub send a single ordered
`live:message` push. Layers are always reconciled before the view updates. The
renderer holds a per-layer fence: until the dupey layer has reconciled a batch,
its rows are shown flat instead of stacked, so the list and the version stacks
never disagree. Focusing the window or making it visible re-syncs the listing
and layers through `live:layers`.

Adding a derived layer needs no new IPC channel. Implement `DerivedLayer` in
the fs worker:

```ts
import type { DerivedLayer } from "./change-hub";
import type { FsDirChange } from "../shared/live-contract";

const myLayer: DerivedLayer<MyData> = {
	id: "my-layer",
	snapshot: () => service.result(),           // current published data
	applyChanges: (dirs: readonly FsDirChange[]) => service.applyDirChanges(dirs),
	resync: () => service.reverify(),           // optional full re-derivation
};
```

Register it in `src/fs-worker/service.ts` where the hub is created
(`hub.register(myLayer)`), and add a selector in
`src/renderer/src/state/layers.ts`. Publications ride the existing
`live:message` push and the `live:layers` resync.

Explicit non-goals: live events never trigger a dupey rescan, so a new or
edited file joins version stacks at the next regular scan. A stack member whose
content changed after the scan is shown as a normal row (detached) until the
next scan. An external rename of a stack member re-points the stack within a 2 s
window. Search results are not live.

## AI Search attachments

Drop files, folders, or links on an AI Search tab's panel, on an AI Search tab
in the tab strip, or on the sidebar's AI Search item to attach them to the next
question:

- **Finder rows** from the list, icon, or column view. Dragging a selected row
  carries the whole selection.
- **Files and folders from another app**, such as macOS Finder. The preload
  resolves each dropped file to its absolute path with Electron's
  `webUtils.getPathForFile`.
- **Links** (`text/uri-list`) dragged from a browser. A `file://` link becomes
  a file attachment.

A drop on the sidebar item turns the focused tab into AI Search; a drop on an
AI Search strip tab switches to it. A bare text drag is not an
attachment. Attachments are deduplicated by path or URL.

On send, `src/main/attachment-context.ts` builds one context block for the
agent. It includes every attachment's path or URL and each file's text. PDF,
Office, HWP, and mail files go through the librarian's document parsers. Other
text files are read as UTF-8. Folders contribute a listing of their children.
Binary files, files over 32 MiB, and links go by path or URL only; the agent
opens them with its own tools when needed. Content is capped at 8,000
characters per attachment and 24,000 per question. The block goes in front of
the run's first model prompt. The query string, which the librarian uses for
baseline retrieval and records in its retrieval memory, stays the user's own
words.

## Right-click menu in Finder and Explorer

Settings → General → **Add to the file right-click menu** (off by default)
adds two entries to the OS file menu, the way Keka or Skim do:

- **Ask AutoRAG** attaches the selected files and folders to AI Search as
  drafts, so you type the question.
- **Show in AutoRAG** opens the file's folder with the file selected.

Captions follow the interface language, and the install is per-user with no
elevation.

| OS | Where it appears | How it is installed |
| --- | --- | --- |
| macOS | Finder right-click → **Quick Actions** (and Services) | Two Automator workflows written to `~/Library/Services`, limited to Finder selections. Each runs a shell script that launches the app's own executable with `--autorag-request=<ask\|reveal>` and one `--autorag-path=` per item. |
| Windows | Explorer right-click on a file or folder | Shell verbs under `HKCU\Software\Classes\{*,Directory}\shell\AutoRAG.*`, written with `reg.exe`. On Windows 11 they sit under "Show more options"; the top-level menu needs a packaged COM `IExplorerCommand`, which an unpackaged Electron app cannot register. |
| Linux | Not offered | There is no common file-manager extension point. |

The launched process does not open a second window. `src/main/os-request-channel.ts`
tries a per-profile local socket (a unix socket in the temp dir, a named pipe
on Windows) first; a running app acknowledges the request and the launcher
exits. With no app running the launcher becomes the app and reads the request
from its own argv. Every path is checked on disk in
`src/main/os-request-service.ts` before the renderer sees it. The profile's
`--user-data-dir` is baked into each entry, so a development or QA profile
only receives its own requests. The app refreshes the entries on every start
while the setting is on, and switching it off removes exactly the entries it
wrote (macOS workflows are recognized by their `com.autorag.app.service.`
bundle identifier). A failed install rejects the toggle instead of saving it.

## Manual QA

The Finder QA scripts are under `scripts/manual-qa/`. Build first, then run a
script with `bun scripts/manual-qa/run-qa-finder-<topic>.mjs`. Evidence belongs
under `.omo/evidence/ai-finder-app/` and is ignored.

`run-qa-finder-drop-attachments.mjs` needs `OPENROUTER_API_KEY`. It drags
Finder rows, drops external files, folders, and links through Chromium's
native drop path, and checks that a live agent answers from the attached
content. With `QA_REAL_FINDER_DRAG=1` it also drags a file out of a real
macOS Finder window. That run moves the mouse, and the terminal needs
Accessibility permission.

`run-qa-finder-os-menu.mjs` is macOS-only. It switches the right-click menu on
against a throwaway home, runs the installed workflows through the real
`automator` runtime, and checks that the running app attaches the files, that
Show in AutoRAG selects the file, and that a cold start attaches from argv.

### Windows QA

The same lane runs on Windows 11. Build first, then run the whole sweep from
PowerShell or cmd:

```sh
bun run build
bun scripts/manual-qa/run-all.mjs                  # all lanes
bun scripts/manual-qa/run-all.mjs live-sync kind   # selected lanes
```

Prerequisites: Node 24+, Bun, `dupey`, and `ffmpeg` on `PATH` (the Inspector's
Windows image backend; without it the image menu stays hidden). The macOS-only
tools (`sips`, `mdls`, `qlmanage`, `osascript`, `pgrep`, `screencapture`) are
never required — `scripts/manual-qa/platform.mjs` swaps in the Windows
equivalents (the registry for file kinds, `tasklist`/`taskkill`, the Recycle
Bin) and scripts that genuinely need macOS log a skip instead of failing.
Lane logs and `summary.json` land in `.omo/evidence/win-qa/`. The sweep also
runs in CI (`.github/workflows/qa-windows.yml`).
