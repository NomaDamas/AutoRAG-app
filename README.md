# AutoRAG Finder

Standalone Electron + React desktop app for the public AutoRAG librarian.

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

### AutoRAG configuration settings

Settings writes to the shared AutoRAG `config.json`; the Finder does not keep a
second datasource or model configuration. The categories are:

- **General** — document languages and app preferences.
- **LLM Models** — provider/model catalog selection, provider endpoint, allowed
  API protocol, and encrypted provider credentials. Runtime capabilities and token
  limits come from the provider catalog or model runtime.
- **Embedding Models** — local MinSync profiles or loopback endpoints, automatic
  model dimensions, request controls, and reindexing warnings.
- **Reranker Models** — the v2.7 OpenRouter reranker, wire model, timeout, and
  encrypted credentials. Other reranker providers are not offered because the
  upstream resolver rejects them; Top N remains at the AutoRAG default.
- **Data Sources** — multiple named connections per datasource template,
  instance ids, channel filters, connector-specific fields, tags, access
  policy, and encrypted GitHub credentials. Unknown config fields are retained.
- **Deep Indexing / Light Indexing / Other Apps** — search paths, MinSync,
  Jikji, platform-detected FSearch/Everything, web search, parser/OCR, dupey,
  datasource access, and exclusions. Installer paths, retrieval limits, P2P,
  and code-folder quick exclusions stay on AutoRAG defaults and are not exposed.

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

Drop files, folders, or links on the AI Search dock to attach them to the next
question:

- **Finder rows** from the list, icon, or column view. Dragging a selected row
  carries the whole selection.
- **Files and folders from another app**, such as macOS Finder. The preload
  resolves each dropped file to its absolute path with Electron's
  `webUtils.getPathForFile`.
- **Links** (`text/uri-list`) dragged from a browser. A `file://` link becomes
  a file attachment.

A drop on the collapsed bar opens the dock. A bare text drag is not an
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
