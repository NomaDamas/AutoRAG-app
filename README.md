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

Settings → 일반 → 화면 모드 controls the entire app with `Light` or `Dark`.
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

Settings follows `docs/prototypes/settings` and writes to the shared AutoRAG
`config.json` and the Pi agent's `auth.json`/`models.json`; the Finder keeps no
second datasource or model configuration. The sidebar is searchable and grouped:

- **계정** — 내 계정 and 구독 및 사용량. AutoRAG has no account or billing
  backend yet, so these pages show no account data; billing actions open the
  AutoRAG billing web pages.
- **기본 → 일반** — appearance, app language, hidden files, launch at login,
  automatic updates, telemetry, and document languages.
- **AI → AI 모델** — connect services through the same Pi `/login` the AutoRAG
  agent uses: subscription sign-in (Claude Pro/Max, ChatGPT Plus/Pro, GitHub
  Copilot, …) opens the browser or shows a device code; API-key providers prompt
  for the key; local (loopback) and OpenAI-compatible servers are discovered and
  saved to `models.json`. Role pickers only list models the catalog returns and
  write `model`, `queryDecomposition`, `jev`, `rerank`, and `thinking.final`.
  The 문서 이해 모델 picker changes `minSync.embedder` through a plan → apply
  flow that propagates the embedder to every datasource CLI that can adopt it
  (mailcrawl env, qmd `QMD_EMBED_MODEL`, discrawl managed config), reports the
  ones that cannot (lazykatok, GitHub Gist, Lark, ClawGallery), refuses to write
  while an enabled source is incompatible unless acknowledged, and runs the real
  per-source rebuilds.
- **AI → 웹 검색** — `webSearch` on/off, provider, and page fetch.
- **검색** — 인덱싱 (per-source status, polling interval, sync now, index
  refresh), 검색 범위 (search paths, exclusions, watch, media index), 문서 읽기
  (languages, OCR), and 중복 파일 정리 (exact duplicates, dupey, scan interval).
- **연결된 앱** — all connections plus a gallery of the 16 datasource templates;
  each configured connection gets its own page with enable, desktop-app
  requirement and download link, per-source AI access, sync, polling interval,
  description, and the template's connector fields.

Every edit is a validated leaf write that preserves unrelated and unknown
config keys. Secrets never enter `config.json`: `/login` stores keys and OAuth
tokens in Pi's `auth.json`, and credential-only keys (for example
`TYPESAFE_API_KEY`) use Electron's encrypted store. Remote embedding endpoints
are rejected; corpus-bearing requests stay on loopback.

The Settings tab is an app-owned UI location, not a filesystem path; it never
issues directory listings, incremental reads, or watcher requests. Returning to
a Finder tab restores its existing folder listing and watch set.

## Live filesystem sync

Folders shown in open tabs are watched for changes made by other apps. A
created, deleted, renamed, or edited file appears in the tab without clicking
anything. Ordinary direct-child changes are applied incrementally: the main
process re-reads only the changed paths and the renderer patches those rows.
An event overflow, a recreated watched root, or a missing-path recovery falls
back to a full relist. Only real folders in open tabs are watched: Recents and
datasource virtual paths never are. Watching uses
`@parcel/watcher`; symlinked folders are canonicalized for native events and
mapped back to the path shown in the tab. Events are coalesced per directory
with a 150 ms trailing debounce and a 1 s maximum wait. Closing a tab,
navigating away, reloading the window, or quitting releases the watches. Set
`AUTORAG_FS_WATCH_DIAG=1` to log watch, unwatch, and batch diagnostics.

All live traffic flows through one serial `ChangeHub` queue in the main
process. For each batch, every registered derived layer reconciles first, with
a 750 ms per-layer timeout, and only then does the hub send a single ordered
`live:message` push. Layers are always reconciled before the view updates. The
renderer holds a per-layer fence: until the dupey layer has reconciled a batch,
its rows are shown flat instead of stacked, so the list and the version stacks
never disagree. Focusing the window or making it visible re-syncs the listing
and layers through `live:layers`.

Adding a derived layer needs no new IPC channel. Implement `DerivedLayer` in
the main process:

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

Register it in `src/main/index.ts` where the hub is created
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
