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

- **계정** — 내 계정 and 구독 및 사용량, read from the hosted AutoRAG service
  (email, plan, weekly credits); sign-in, checkout and the
  billing portal open in the system browser. Signed out, every value reads
  "확인할 수 없음".
- **기본 → 일반** — appearance, app language, hidden files, launch at login,
  automatic updates, telemetry, and document languages.
- **AI → AI 모델** — the AutoRAG plan is listed first and connects through the
  account service (not Pi's login); other services use the same Pi `/login` the AutoRAG
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
- **검색** — 인덱싱 (per-source status, refresh cadence, sync now, index
  refresh), 검색 범위 (search paths, exclusions, watch), 문서 읽기
  (document languages), and 중복 파일 정리 (exact duplicates, dupey, scan interval).
  Folders named in `appIndexing.codeFolderNames` (`node_modules`, `.git`, …) and
  every folder whose name starts with `.` (always, no setting)
  are left out of indexing; the app finds them itself and passes them as
  `excludePaths`. OCR (`parserOptions.ocr.enabled`, which makes the librarian parse image files) and Jikji's media index are pinned off in every
  config the app hands to the librarian.
- **Automatic refresh** — a cadence is `직접` (manual, the default) or 5 min to a
  day, for the local folders (`appIndexing.refreshIntervalMs`) and for each
  datasource (`pollingIntervalMs`). Choosing one registers an OS job that runs
  without the app open: a LaunchAgent (`com.autorag.app.refresh`) on macOS, a
  marked crontab line on Linux, a Task Scheduler task on Windows. It wakes at
  most every 30 minutes and refreshes only what is due, through the same code as
  the Settings buttons (`index-refresh`), under one lock so a button press and
  a tick never overlap. Results land in `app-refresh/state.json` beside the
  config. The app never edits a crontab line or LaunchAgent it did not create and
  only warns when another job already refreshes AutoRAG.
- **Indexing progress** — a block above 설정 in the sidebar shows what is
  indexing right now, with a progress bar: the local folders and every
  datasource, whether the run came from a Settings button, the OS job, or an
  `autorag watch` outside the app. It names the running phase or datasource,
  shows `done/total` for a multi-item run, turns green for "완료" (or orange with
  the reason on a failure) and disappears a few seconds later (15 s after a
  failure). Clicking it opens 설정 > 인덱싱, whose top section (진행 상황) lists
  every item of the run. Sources: the librarian's
  `<workspace>/.autorag/refresh-progress.json` (phase, parsed counts; a run is
  live while its `pid` is, never judged by `updatedAt`, which only moves between
  phases) and `app-refresh/activity.json`, the plan of whoever holds the refresh
  lock (manual buttons and the OS job). The bar is a position, not a percent of
  work: the librarian reports phases, not per-file totals, and a datasource sync
  reports nothing while it runs, so the bar steps per finished item and is a
  shimmer while a lone datasource syncs. Per-file and per-source progress is
  requested upstream in Marker-Inc-Korea/AutoRAG#1840.
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
## First-run onboarding

A fresh install opens onboarding instead of the Finder: welcome, permissions,
account, folders, embedding, data sources, plan, the model step (BYOK only), and
the first index. The screens port
`docs/design-reference/onboarding/onboarding-prototype.html`; the draft is saved
after every change, so a relaunch (for example after granting Full Disk Access)
resumes at the same step.

- **Permissions** probe Full Disk Access for real (macOS) and re-check every two
  seconds. Notifications post a real system notification; if macOS reports the
  app is not allowed, the step says so and opens the system notification
  settings (the unsigned dev binary is never allowed, so this only works in a
  signed build). Launch at login is the same setting as Settings › General and
  registers the OS login item in packaged builds only (registering the dev
  binary would add bare "Electron" to Login Items); the switch is read back from
  the OS and flips off with a message if the OS refused.
- **Folders** are pre-scanned with the indexer's own rules (supported
  extensions, size cap, skipped dependency/code folders) to show real file
  counts and an ETA.
- **Embedding** is local (`qwen3-embedding-0.6b`); cloud embedding is shown but
  unavailable, since corpus text is never sent to remote embedders.
- **Data sources** list only usable connectors, and every one starts off. The
  probes run in parallel and each row appears the moment its own probe finishes
  (fast ones first); a "checking" line stays under the list until all of them are
  done, and only then does the "connect later" row appear, minus whatever was
  found. There is no description to write: onboarding stores none, and the
  agent-facing description is meant to be generated from the indexed content.
  Local files are covered by the folders step, so
  Spotlight and Apple Mail are not offered. Each row appears only when the
  connector's own health probe says its data is reachable: KakaoTalk
  (`lazykatok doctor --macos-probe`: app, container, cached login, readable
  database files), Slack (`slacrawl`, at least one workspace), Discord
  (`discrawl` ready database plus a dry-run `wiretap` that finds messages),
  Telegram (`telecrawl doctor`), WhatsApp (`wacrawl doctor`, read-only, with
  messages), mail (`mailcrawl` installed and a `himalaya` account whose login
  succeeds), GitHub, and Obsidian. Mail writes one `mailcrawl-<account>` archive
  per verified account under `~/.mailcrawl/<account>`; accounts that cannot log
  in are skipped. GitHub requires authentication and at least one discovered
  repository; empty or failed repo discovery does not offer a source that would
  fail its first sync.
- **Model** (BYOK) verifies the provider key against the provider's API and
  stores it in the encrypted credential store, never in `config.json`.
- **Indexing** writes `searchPaths`, the embedder (only when none is set), the
  enabled datasources and their access tags, and the BYOK model into the shared
  config, then runs the same refresh as Settings. A config still pointing its
  `workspacePath` at the app's cwd seed is moved to `<AutoRAG home>/workspace`.
  The Finder opens only after the first index succeeds.

Account and plan are real. The account step signs in through the system
browser (OAuth 2.0 authorization code + PKCE over a loopback redirect, RFC 8252)
against the hosted AutoRAG service (`AUTORAG_BASE_URL`, default
`https://api.dazziapp.com`); no password and no card number is typed into the
app. The returned API key (`AUTORAG_API_KEY`) lives only in the encrypted
credential store and `process.env`, exactly like a BYOK key; the renderer sees
an `AccountStatus` (email, plan, subscription state, weekly credits), never the
key. Air and Pro open the service's hosted checkout in the browser, and the plan
step continues once the server reports that plan; cancel, refund, and the
payment method live in the hosted billing portal (Settings › 구독 및 사용량).
Skipping the account is the BYOK path.

**What signing in changes.** A successful sign-in (onboarding, Settings, or the
AutoRAG entry in Settings › AI) points the agent at the account's models, per
role, in the shared `config.json` (the config carries an explicit `baseUrl` and
`apiKeyEnv`, never the key):

| Role | Replaced when the config holds | Kept when it holds |
|---|---|---|
| answer `model` | nothing, or an AutoRAG model | any other provider's model |
| `queryDecomposition` | nothing, an AutoRAG model, or the librarian's untouched default | another model you chose (including another OpenRouter one) or `false` |
| `jev` | nothing, the librarian's untouched OpenRouter default, or a bare AutoRAG block | `false`, another backend, or an AutoRAG block you switched off (`enabled: false`) or tuned |
| `rerank` | the same | the same (`topN`, `baseUrl`, … count as tuning) |

The model ids come from the server (`GET /v1/models`, `?operation=jev|rerank`);
a list that cannot be fetched leaves that role alone. Settings › 계정 › "계정
모델로 설정" applies the plan to the answer and decomposition roles
unconditionally. The corpus-text rule is unchanged: embeddings stay on this Mac.

Onboarding state lives in `<userData>/onboarding/state.json`. Set
`AUTORAG_SKIP_ONBOARDING=1` to open the Finder directly; the manual-QA launcher
does this for every lane except `run-qa-onboarding.mjs`.

`make onboarding` walks the flow on a disposable profile: every run starts from
scratch in a temp sandbox holding its own `userData` (via `--user-data-dir`),
AutoRAG config, home, and workspace, so the real `~/.autorag` and the app's
support directory are never read or written. The cached embedding model and
llama runtime are copied in so the first index runs offline. When the app exits
the wrapper kills the run's processes and removes the sandbox; a SIGKILL of
the wrapper is covered by a detached watchdog, and the next `make onboarding`
sweeps any sandbox whose owner and watchdog both died. The QA lane covers the
same flow end to end in CI settings (`bun scripts/manual-qa/run-qa-onboarding.mjs`).
For a detected datasource regression, set `QA_ONBOARDING_SOURCE=github`,
`mail`, `spotlight`, or `slack` before that command; it enables only that row
and asserts its written connector config and access tag. The run uses temporary
AutoRAG state but the selected external crawler uses its real store, as noted
below.

Scope of that isolation: the sandbox holds AutoRAG's own state (userData,
config, home, workspace, index). External datasource crawlers are CLIs with
their own stores in the real home, and the librarian passes `HOME` through to
them, so enabling a source in onboarding syncs the real store — `slacrawl` reads
and writes `~/.slacrawl` (Slack's local mirror), the other messenger crawlers
import into their own stores the same way, and Obsidian reads the real vaults.
Detection and the first sync are real by
design; they never touch other apps' data beyond their own store.

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

## Services in AutoRAG's own right-click menu (macOS)

The reverse direction: right-click a row (or the empty space of a folder) in
AutoRAG and the **Services** submenu lists what other apps register with macOS
for those files, the same entries Finder shows under right-click → Services:
Keka's *Send to Keka* / *Extract using Keka* / *Compress using Keka*, a
Terminal's *New Terminal at Folder*, QSpace, Quick Action workflows, and so on.
Clicking one performs it on the selection (the whole multi-selection for a row;
the folder in view for empty space), and the target app receives the files just
as it would from Finder. An application's services sit under one row named for
it; services without an application prefix sit directly in the submenu.

- **How it is discovered.** `src/main/services-service.ts` reads the system's
  service registry (`pbs -dump_pboard`, the data behind Finder's Services menu)
  plus the user's per-service switches from System Settings, and asks Launch
  Services which file types each selected path conforms to. Finder's rules are
  plain TypeScript (`selectServices`): the service must take files (or text that
  is declared a file path), must not be bound to another application, must
  accept every selected path's type, must not be restricted or switched off for
  the context menu, and this app's own Finder Quick Actions are left out.
- **How it runs.** `NSPerformService` through `osascript`, with the file URLs,
  the filename list, and the path text on a private pasteboard. The service id
  and paths are `argv`, never script text. The service is performed only if the
  system still offers it for exactly that selection, so a stale or forged id from
  the renderer cannot run anything.
- **Quiet degrade.** The menu opens at once; the Services row appears when the
  lookup answers (a stale answer for an earlier right-click is dropped). A failed
  lookup is an empty menu. The row is absent in the Trash, and off macOS.
- **Windows.** Not offered. Explorer's verbs are COM `IContextMenu` handlers and
  registry entries with no public API for an unpackaged app to enumerate and run
  against a selection, so the submenu stays macOS-only rather than guess.

`run-qa-finder-services.mjs` (macOS) registers a temporary Quick Action with
the real system, then right-clicks in the built app and checks: the service is
listed, it receives the exact path (spaces, quotes, and Hangul included), a
two-row selection hands both paths over, the empty-space menu acts on the
folder in view, a folder-only service is offered for a folder and not a file,
and (when Keka is installed) Keka's group opens a visible second-level popout
whose *Send to Keka* launches Keka. The probe is removed afterwards.

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

## Releases and installers

Publishing a GitHub release builds `AutoRAG-<version>-arm64.dmg` and
`AutoRAG-Setup-<version>-x64.exe` and attaches them to it. Each installer carries
the app plus every program it drives (the `autorag` agent, minsync, jikji, dupey,
the datasource crawlers, rhwp, kordoc, Node and npm-based CLIs) and the local
Qwen3 embedding model, so one download is the whole install. See
[`docs/release.md`](docs/release.md) for the contents, the signing secrets to
configure, and how to rehearse a release.

## License

AutoRAG is licensed under the GNU Affero General Public License v3.0
(`AGPL-3.0-only`); see [`LICENSE`](LICENSE). Bundled third-party components
and their licenses are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
