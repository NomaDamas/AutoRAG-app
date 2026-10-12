# Finder performance benchmark

Benchmark command:

```sh
bun run build
bun scripts/benchmarks/finder-performance.mjs \
  --output .omo/evidence/finder-performance/production.json
```

The benchmark drives the real built Electron app through Playwright with a
throwaway fixture tree and isolated user data. It reads `$HOME/Downloads` and
`$HOME/Desktop` only; it never writes to private folders. It measures basic
`listDir` latency and payload size, deferred `enrichEntries` cost, the target
folder's first painted row, mounted DOM rows, rAF scroll intervals, and Quick
Look image/PDF readiness. Evidence JSON stays in the ignored `.omo/evidence`
directory; nothing here commits private data.

Dev renderer runs use the same benchmark with `--renderer-url`:

```sh
bun scripts/benchmarks/finder-performance.mjs \
  --renderer-url http://localhost:5173 \
  --output .omo/evidence/finder-performance/dev.json
```

## Production before/after (macOS, 2026-10-02)

Baseline is the archived production build of commit `46ce171` (pre-change
`listDir` blocked on OS kind lookups and thumbnail generation, and the list
rendered every row). Current is this branch's build, same fixture shape, same
machine, cold icon caches.

| Scenario (entries) | Baseline first list response | Current basic list (cold → warm) | Baseline first folder paint | Current first folder paint | Baseline mounted rows | Current mounted rows |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| ~/Downloads (374) | 12,067 ms → 4,353 ms | 4.9 ms → 5.5 ms | 12,116 ms | 56.9 ms | 366 | 27 |
| ~/Desktop (49) | 4,023 ms → 0.7 ms | 0.8 ms → 9.5 ms | 4,060 ms | 53.9 ms | 43 | 27 |
| fixture normal-341 | 338.7 ms → 2.6 ms | 2.7 ms → 19.9 ms | 748 ms | 101.9 ms | 341 | 27 |
| fixture media-heavy (202) | 1.5 ms → 1.4 ms | 2.3 ms → 13 ms | 358 ms | 79.4 ms | 202 | 27 |
| fixture flat-5000 | 617.8 ms → 576.1 ms | 38.2 ms → 97.3 ms | 754 ms | 83.1 ms | 5,000 | 27 |
| fixture nested level-2 (500) | 611.2 ms → 133.4 ms | 3.3 ms → 39.1 ms | 640 ms | 56.5 ms | 500 | 27 |
| Recents (17 seeded) | 0.7 ms | 0.7 ms → 0.5 ms | 68 ms | 62.7 ms | 17 | 17 |

The baseline cold numbers include OS kind lookups and thumbnail generation
inside `listDir`; the current basic list does filesystem metadata only, so the
first row paints before any enrichment lands. Warm baseline repeats for
~/Desktop and media-heavy were fast because their caches were already hot from
the first response.

## IPC payload (issue #17)

The `autorag-thumb://` protocol moved icon bytes out of the IPC payload.

- ~/Downloads list payload: 4,181,779 bytes (base64 icons for 276 files) →
  105,494 bytes (zero icon fields; icons arrive as short URLs in a separate
  deferred enrichment pass).
- flat-5000 list payload: 1,874,841 bytes (480 icon fields) → 1,355,121 bytes
  with zero icon fields; the deferred enrichment response carries only paths
  and short URLs.
- PNG bytes stay in a bounded main-process LRU cache; Chromium decodes them
  off the main thread via lazy `<img loading="lazy" decoding="async">`.

## Scroll frames (issue #16)

rAF intervals while scrolling the whole 5,000-entry list and icon grid in the
production build: list p95 18.4 ms, icon grid p95 18.1 ms, zero frames over
33 ms. The baseline (all 5,000 rows mounted) showed similar p95 on this
machine, but the current DOM keeps only ~27 rows mounted at any scroll
position (27 vs 5,000 mounted rows), which is what keeps first paint and
reconciliation cheap as folders grow.

## Dev renderer

The same benchmark against the Vite dev server (`--renderer-url
http://localhost:5173`): first paint 57–96 ms across the same scenarios,
5,000-entry scroll p95 18 ms, one frame over 33 ms in one Downloads run
(168.5 ms, dev-tool overhead during the thumbnail-enrichment window).
Dev is not the performance bottleneck anymore; the blocking-IO design was.

## Quick Look readiness

Space → visible preview content: image 43 ms, PDF 55 ms (both windows
visible), unchanged from the baseline shape because the preview pipeline was
already streaming-based.

## Tab switching

```sh
bun run build
bun scripts/benchmarks/finder-tab-switch.mjs --view list \
  --seed-user-data "$HOME/Library/Application Support/@autorag/app"
# Dev renderer, as `make run` serves it. `--rendererOnly` still spawns
# Electron (on the real userData) and exits with it, so hand it a stand-in:
printf '#!/bin/sh\nexec sleep 86400\n' > /tmp/noop-electron && chmod +x /tmp/noop-electron
ELECTRON_EXEC_PATH=/tmp/noop-electron node_modules/.bin/electron-vite dev --rendererOnly &
bun scripts/benchmarks/finder-tab-switch.mjs --renderer-url http://localhost:5173 \
  --seed-user-data "$HOME/Library/Application Support/@autorag/app"
```

Two tabs on ~/Downloads (376 entries) and ~/Desktop (48); every switch is a
click on the other tab, 8 each way, sampling every animation frame for 1.5 s.
`--seed-user-data` copies only `dupey-cache` and `settings`, so version stacks
match a real install. "First correct frame" is the first frame with the target
tab's title over rows that live in the target folder; "last change" is the
last frame whose rows or icons still changed; a "stale frame" named the target
folder over the previous tab's rows.

Before, a switch only moved `activeId`. The controller holds one listing, so
the first frame put the new title over the previous tab's rows; the effect then
relisted the folder over IPC and painted bare rows (letter tiles, no OS icons),
and the enrichment pass painted the icons again: three pictures per switch.
Now the directory store (`src/renderer/src/data/directory-store.ts`) keeps the
last listing of every folder a pane showed recently, so the render that switches
tabs reads the target folder's snapshot and the first frame is that folder with
its icons (icons live in the entry sidecar, keyed by path + mtime, and survive
the switch). The reload the switch starts is a revalidation: `reconcileListing`
keeps rows that are unchanged on disk (same path and mtime) with their object
identity, so an unchanged folder keeps the same array and paints nothing more,
and a folder that changed while its tab was in the background updates in place.

### Tab hit area and background refresh safety

The entire `.tab` segment is now the activation target, not only the title
button. The close button stops propagation, so clicking it never switches tabs.
The title remains a real button for keyboard activation and accessibility.

The snapshot does not suppress filesystem changes. The native watcher keeps
every open real directory in its watch set; the store applies live patches to
the folders a view currently shows and revalidates a cached folder the moment
a tab shows it again. Each folder's reads carry a request sequence, so an
earlier answer can never overwrite a newer one or resurrect a deleted or
renamed row, and a folder evicted from the cache drops a listing that lands
late instead of re-creating it. Enrichment is keyed by file version, so new,
deleted, or modified entries never pick up a stale icon or OS kind.

Every pane reads the same snapshot for a folder, so a tab's listing, the first
column pane, and an expanded subfolder showing the same folder can no longer
drift apart (the follow-up that used to swap two caches on every tab switch is
gone with the caches). Electron smoke coverage verifies that an inactive-tab
create and delete both appear on return, and that the first frame contains
only the selected tab's folder.

Dev renderer (macOS, 2026-10-03), p50 / p90 ms:

| view | to | first correct frame (before → after) | last change (before → after) | stale frames, mean |
| --- | --- | ---: | ---: | ---: |
| list | Downloads | 43.8 / 56.2 → 15.8 / 17.0 | 43.8 / 56.2 → none | 1.4 → 0 |
| list | Desktop | 47.8 / 59.8 → 15.7 / 17.7 | 58.4 / 73.8 → none | 1.5 → 0 |
| icons | Downloads | 43.6 / 74.6 → 16.6 / 27.9 | 59.2 / 90.6 → none | 1.6 → 0 |
| icons | Desktop | 46.1 / 73.6 → 15.2 / 26.0 | 58.3 / 73.6 → none | 1.8 → 0 |
| columns | Downloads | 42.2 / 46.1 → 41.3 / 42.5 | 121.2 / 132.2 → none | 0 → 0 |
| columns | Desktop | 14.3 / 15.1 → 14.4 / 15.6 | 54.5 / 55.6 → none | 0 → 0 |

Production build, same runs: the first correct frame was already about one
frame (list 17.4 / 21.5 → 14.7 / 16.0 ms for Downloads); what changes is that
2–4 of every 8 switches used to repaint 20–38 ms later (bare rows, then icons)
and now none do. The columns ~41 ms for Downloads is the dev build rendering all
348 rows of the unvirtualized column pane (14.5 ms in production); the IPC
cost is not on the switch path any more (`listDir` 3.4 ms, `enrichEntries`
1.7 ms, `indexStatus` 8.4 ms warm for Downloads, now all off-screen).

## Regression suites passing on this branch

`bun run typecheck`, `bun run test`, `bun run build`, plus manual QA:
thumbnails (protocol + pixel-true tiles + native path) 11/11, thumbnail scroll
fill 3/3, os-kind 5/5, view-modes 33/33, folder-tree 14/14, Recents PASS
(including reveal-into-virtualized-list), trash-prune PASS, live-sync PASS
(15 scenarios incl. 5,000-file live create, scroll preservation, overflow
relist).

## Native thumbnail generation (issue #24)

macOS/Windows tiles no longer shell out to `/usr/bin/qlmanage`; the icon
provider calls Electron's in-process `nativeImage.createThumbnailFromPath`
(`src/main/file-icon.ts`). Linux keeps `app.getFileIcon`. Native Quick Look is
requested only for visual extensions (images, video, and PDF); plain text,
source, office, archive, and other non-visual files keep their letter tiles.
This avoids sending large plain-text folders through Quick Look, where macOS
can wait for the full 4 s deadline without producing a useful thumbnail. The
provider still caches successful and negative visual lookups by path + mtime.

This removes the qlmanage process pool, its temp dirs, the 4 s `execFile`
timeout, and the Dock-tile/orphan leak with them.
`scripts/manual-qa/benchmark-thumbnails.mjs` drives the built app over three
fixture dirs (24 noisy 1024×768 PNGs + 8 PDFs each) and times the renderer's
real path, `fs.listDir` → `fs.enrichEntries(targets, true)`, cold (generation)
and warm (cache hit), while sampling `pgrep -x qlmanage`. Median cold across
runs, same machine:

| build | cold median | cold range | warm | qlmanage during cold |
|---|---|---|---|---|
| `main` (qlmanage) | ~105–130 ms | 86–505 ms | 0–1 ms | 3 spawned, 1 orphan left per run |
| native (this branch) | ~105 ms | 94–129 ms | 0–1 ms | 0 |

Typical cold generation is unchanged; the native path removes qlmanage's
400–500 ms spikes (daemon/process contention) and is stable run to run. Warm
listings are identical because both paths serve the same in-process LRU cache.
The Quick Look daemon serializes thumbnailing (~4–5 ms/file throughput), so
raising `THUMBNAIL_CONCURRENCY` above 8 does not change cold time — the bound
exists to cap in-flight lookups, not to add speed.

Regression gate: `run-qa-finder-thumbnails.mjs` reaps pre-existing qlmanage
orphans, then asserts the count stays 0 while generating 40 thumbnails and that
every image still yields a thumbnail.

### Viewport-driven thumbnail fill

The icon provider caps one enrichment call at `ICON_LIMIT` (240) targets, so
the single background pass that follows a listing only covered the first 240
files of a folder; rows past that kept their letter tile and scrolling never
asked again. Both views are virtualized, so a mounted row *is* a near-viewport
row: `FileRow`/`IconTile` report themselves through `RowCallbacks.onVisible`,
and the directory store coalesces those requests (keyed by `thumbnailKey`, path
\+ mtime) into one `fs.enrichEntries` batch every 60 ms. The icons land in the
entry sidecar, and only the rows that got one re-render. A folder larger than
the cap now fills in as the user scrolls, in both the list and the icon grid.

`run-qa-finder-thumbnail-scroll.mjs` is the gate: a 300-image folder (names
zero-padded so the bottom rows are exactly the ones past the 240 cap). Row 300
is proven unmounted before scrolling, then must show a thumbnail after scrolling
to the bottom, with qlmanage still at 0. Red on `main` (no thumbnail, qlmanage
spawned), green here — 3/3.

## Memory soak, per-click IPC, and clean quit (FS roadmap #104, stage 1)

Two lanes measure what a long session accumulates; both run against an
isolated fixture root and user data:

```sh
bun run build
SOAK_ENFORCE=1 bun scripts/manual-qa/run-qa-finder-memory-soak.mjs   # 40 cycles
QUIT_ROUNDS=30 bun scripts/manual-qa/run-qa-finder-quit-clean.mjs
```

The soak lane browses three 400-file folders per cycle (row clicks, Quick
Look, view-mode switches, ⌘T/⌘W) and reads the renderer heap after a forced
GC (CDP `Runtime.getHeapUsage`), the main-process event-loop delay p99, and
how many `index:status` IPC calls a row click sends. Without
`SOAK_ENFORCE=1` it only reports, so a baseline run records its figures.

Production build, macOS, 40 cycles after a 5-cycle warm-up:

| metric | `main` | this change | gate |
| --- | ---: | ---: | ---: |
| retained renderer heap growth | 6.74 MB/cycle (46.7 → 316.3 MB) | 0.10 MB/cycle (12.3 → 16.3 MB, plateaus) | ≤ 0.25 |
| `index:status` IPC per row click | 1 | 0 | 0 |
| main event-loop delay p99 | 98.5 ms | 14.1 ms | < 100 |
| quit with live folder watches | 2 of 20 SIGABRT | 0 of 30 | 0 |

What changed:

- **Closure-chain leak.** Every memoized controller handler kept the whole
  render scope it was created in, and those scopes linked through older
  handlers still held by rows, the controller store, and event listeners, so
  every past listing stayed reachable. Handlers now go through
  `useLatestCallback` (one stable function reading the latest closure through
  a ref) and `FinderPane` memoizes the row callbacks.
- **Per-click IPC.** The index-status read keyed on `viewEntries`, which is a
  new array on every selection change; it now keys on the visible file set.
  Each read also ran the app-indexing directory walk (up to 20,000 entries)
  synchronously on the main thread; that walk is asynchronous now.
- **Selection vs. sorting.** The sort → stack → group → tree pipeline re-ran on
  every click because version stacks open on selection. It now depends only on
  the selected stack heads/members (`stackSelectionKeys`).
- **Unbounded caches.** Column-pane and expanded-folder listings are pruned to
  what is on screen; the index-status map keeps only visible files; the OS-kind
  cache (keyed by path for extensionless files) is an LRU capped at 2,048.
- **Quit.** `will-quit` started the `@parcel/watcher` teardown without waiting,
  so a native unsubscribe could finish inside Node's environment teardown and
  abort the process. Quit now waits for the watches to release (bounded at
  2 s), then exits.

## Directory store and entry sidecar (FS roadmap #99, stage 2)

Folder listings moved out of React. `src/renderer/src/data/directory-store.ts`
holds one snapshot per folder (`{ dir, version, entries, loaded, loading,
error }`), shared by every pane, tab, column pane, and expanded subfolder.
Views retain the folders they show; released folders stay in a 32-entry LRU
so a tab switched back to paints at once. The store owns the listing reads
(one in-flight silent read per folder, newest answer wins), live incremental
patches, and the background enrichment that follows a listing.
`src/renderer/src/data/entry-sidecar.ts` keeps the OS kind, tile icon, and
Finder metadata keyed by path + mtime, and the AutoRAG index state by path.
Rows subscribe to their own path (`useEntrySidecar`), so an icon batch
re-renders only the rows it touched; the listing array and the sorted rows
stay as they were. The sort pipeline (`useRowPipeline`) reads the sidecar only
when the chosen sort or group uses enrichment (Kind, Tags, Date Added, …).
`useFinderController` is split into the data hook (`useFolderListings`), the
view pipeline (`useRowPipeline`), and keyboard input (`useFinderKeyboard`).
`listingCache`, `tabListingsRef`, `paneListings`, and `childListings` are gone.

```sh
bun run build
SOAK_CYCLES=100 bun scripts/manual-qa/run-qa-finder-memory-soak.mjs
```

The soak lane now also counts listing and enrichment IPC per cycle, renderer
script time, a 600-image thumbnail fill (scroll to the last row until its
thumbnail shows), and takes a heap snapshot at the end. "Listing generations"
is the number of row objects alive for one path across all row arrays (the
listing and the arrays derived from it); 1 means only the current listing is
alive.

Production build, macOS, 100 cycles after a 5-cycle warm-up, same machine:

| metric | `main` | this change |
| --- | ---: | ---: |
| listing generations alive per folder (end snapshot) | 5 | 1 (gate) |
| duplicate listed row objects (end snapshot) | 1,356 | 0 |
| retained renderer heap growth, 100 cycles | +5.0 MB (11.7 → 16.6, flat after cycle 20) | +5.3 MB (12.4 → 17.7, flat after cycle 20) |
| `fs:enrichEntries` calls per cycle | 15.7 | 0.1 |
| `fs:finderMetadata` calls per cycle | 8 | 0 |
| renderer script time per cycle | 194.2 ms | 185.5 ms |
| 600-image thumbnail fill: renderer script time | 77 ms | 64 ms |
| `index:status` IPC per row click | 0 | 0 |
| main event-loop delay p99 | 16.6 ms | 15.4 ms |

Tab switching (`finder-tab-switch.mjs --view list`) is unchanged at about one
frame: first correct frame p50/p90 Downloads 15.5 / 16.0 → 15.2 / 15.8 ms,
Desktop 15.6 / 16.6 → 15.7 / 16.0 ms, zero stale frames and no follow-up
repaint in both.

The heap does not grow after warm-up in either build; what changed is what it
holds. On `main` five generations of the last folder's listing were alive at
the end (each enrichment batch rewrote the array, and older copies stayed
reachable); now one is. Revisiting a folder no longer re-asks the OS for kinds,
icons, or metadata it already answered for the same file version, which is
where the IPC drop comes from. The ~1 MB higher baseline is the sidecar's
records and the cached folders, both bounded.

## Filesystem worker (FS roadmap #101, stage 4)

Listings, watches, Finder metadata, OS kinds, places, the dupey scan, and the
index badges moved off the main process into one Electron utility process,
"Dazzi File System" (`src/fs-worker/`). The renderer reaches it over a
`MessagePort` (`{ id, op, args }` → `{ id, ok, value | error }`, cancel →
`AbortController` in the worker); main only brokers ports, restarts the worker
when it dies, and serves the Electron-only ops it asks for (thumbnails, file
icons, Trash, open, clipboard). Quick Look's "Open with …" lookup spawns
`osascript`, and a child spawn blocks its caller for the fork, so it also runs
in the worker now.

```sh
bun run build
SOAK_CYCLES=100 SOAK_ENFORCE=1 bun scripts/manual-qa/run-qa-finder-memory-soak.mjs
bun scripts/manual-qa/run-qa-finder-fs-worker-crash.mjs
QUIT_ROUNDS=50 bun scripts/manual-qa/run-qa-finder-quit-clean.mjs
```

The soak gate on main's event-loop delay p99 tightened from 100 ms to 16 ms
(one frame), and it now also fails when the worker restarted mid-soak. The
worker counts its own requests per op; the soak reads those counts instead of
wrapping `ipcMain` handlers, since FS calls no longer pass through main.

Production build, macOS, 100 cycles after a 5-cycle warm-up, same machine:

| metric | `main` | this change | gate |
| --- | ---: | ---: | ---: |
| main event-loop delay p99 (two runs) | 15.4 ms | 15.0 / 12.8 ms | < 16 |
| main event-loop delay max | 2,244 ms | 35.6 / 37.8 ms | |
| main RSS, start → end | 658 → 512 MB | 415 → 373 / 412 → 432 MB | |
| retained renderer heap growth | 0.052 MB/cycle | 0.053 / 0.052 MB/cycle | ≤ 0.25 |
| listing generations alive per folder | 1 | 1 | ≤ 1 |
| renderer script time per cycle | 239.6 ms | 251.4 / 252.2 ms | |
| 600-image thumbnail fill | 2,331 ms | 2,187 / 2,071 ms | |
| fs worker SIGKILL → open tab relisted | main dies with it | 1.26 / 1.46 s (2 kills each) | < 5 s |
| quit, 50 rounds: signal exits / crash reports | 0 / 0 | 0 / 0 | 0 |

p99 on `main` sat right at the line (15.4 ms here, 16.6 ms in the stage-2
run), so one soak is noisy around 16 ms. Three 30-cycle A/B pairs before the
Quick Look fix put both builds at 16.7–19.3 ms; attributing each stall over
12 ms to the soak step it happened in showed listing, view switches, and tabs
all under 16 ms, and every frame-length stall on Quick Look open — 20–37 ms
spent in `child_process.spawn` for the default-app lookup. With the same soak
minus Quick Look, the worker build was 13.0 ms against 16.7 ms on `main`.
After moving the lookup into the worker, the Quick Look steps' worst stall
dropped from ~30 ms to ~13–18 ms.

What a worker crash costs: about 1.3 s, almost all of it the new worker
booting (bundle and librarian load) before its first answer. Unanswered reads
are re-sent to the new worker; writes (copy, move, duplicate, rename, trash,
create, undo, eject) are not, and fail with a message asking the user to check
the result, because the first attempt may already have changed the disk.

Not moved: thumbnails and file icons stay on main (`nativeImage` and
`app.getFileIcon` do not exist in a utility process). Their encode cost on main
is small: `toPNG` of a 640 px Quick Look thumbnail measured 2.5 ms at most.

## 10,000-file folder lane (FS roadmap #100, stage 3)

```sh
bun run build
bun scripts/manual-qa/run-qa-finder-large-folder.mjs     # LARGE_RUNS=5, LARGE_FILES=10000
```

Each run starts the built app on fresh user data and opens a 10,000-file
fixture folder from the QA root. It reports the median, min, and max over the
runs for:

- first paint: double-click to the first rAF frame showing a row of the folder;
- listing heap: renderer heap after a forced GC with the folder shown, minus
  the same reading at the QA root;
- row bytes: from a heap snapshot, the bytes only the folder's row objects
  hold (the rows, their own strings and property stores), plus the row fields;
- Name ↓ and Date Modified ↓ sort: column click to the frame with the expected
  first row;
- the `fs:listDir` answer: round trip, JSON bytes, and fields.

The lane holds the folder's enrichment inside the filesystem worker
(`AUTORAG_FS_WORKER_QA=1` registers `fs-worker:qaHoldEnrichment`), so the
listing readings never race the OS kind pass. It releases that pass before the
second heap reading; the Finder metadata pass stays held, because 10,000 files
would keep helper processes busy for minutes and the run quits first.

Baseline, `main` 5d10783, production build, macOS, 5 runs:

| metric | median (min–max) |
| --- | ---: |
| first paint | 260.6 ms (171.1–360.1) |
| renderer script time, open → settled | 29 ms (26–33) |
| listing heap | 9.41 MB (8.10–9.45) |
| listing heap after the kind/icon pass | 10.11 MB (10.09–10.22) |
| row bytes (heap snapshot) | 1,587,520 B, 159 B/row, 14 fields |
| Name ↓ sort | 62.3 ms (40.0–131.8) |
| Date Modified ↓ sort | 58.5 ms (37.7–149.0) |
| `fs:listDir` round trip | 99.7 ms (73.6–218.8) |
| `fs:listDir` JSON | 3,000,112 B, 10 fields |

## Lightweight entry records, labels at render time (FS roadmap #100, stage 3)

`FsEntry` crosses the worker port as plain filesystem values: `{ name, path, kind, ext,
size, mtimeMs, birthtimeMs?, flags }` (`FS_ENTRY_SYMLINK` is bit 1). The ISO
`modifiedAt`/`createdAt` strings, `isSymlink`, and the always-null `osKind`
and `iconUrl` placeholders are gone. Enrichment targets and answers carry
`mtimeMs` as the file-version identity, and so do the icon cache and the
`autorag-thumb://` URL (`mtime=<epoch ms>`); the worker validates it as a
finite number, and main's icon-target parser accepts the same shape. The version-family snapshot moved
to format 2. A version 1 file reads as missing, and the service rescans.

The renderer row (`FinderEntry`) holds those values and nothing derived from
them: 7 fields instead of 14 on a 10k listing. `path` stays on the row because
search hits, Recents, and version families mix folders, and every
selection/clipboard/IPC call keys on it. The parent folder is `dirname(path)`
(`locationOf`), not a copy per row. The date, size, and kind labels, the
Finder-metadata sort and group values, and the Inspector summaries all come
from `state/entry-values.ts` at the moment a cell renders or a sort runs.
`formatModified` (keyed by epoch second) and `formatSize` (keyed by bytes) each
memoize at most 4,096 inputs. The sidecar still merges the OS kind, icon, and
Finder metadata onto a resolved row (`osKind`, `iconUrl`, `finder`), as raw
values.

Sorting precomputes each row's key once (a `Float64Array` for numeric keys, a
string array for collator keys) and sorts indices. Measured on 10,000 rows:
the comparator alone and the decorated sort cost the same for Name (20.2 vs
20.3 ms) and Kind (22.3 vs 21.7 ms). For Where, the decorated sort avoids
re-deriving the folder in every comparison (73.9 → 27.3 ms). A rank cache over
unique keys was no faster than `collator.compare` (20.2 vs 19.5 ms on ASCII
names), so it was not adopted.

`run-qa-finder-large-folder.mjs`, production build, macOS, 20 rounds per build
interleaved (main launch, then this change, alternating; both sides built from
current `main`), median (min–max):

| metric | `main` | this change |
| --- | ---: | ---: |
| first paint | 239.6 ms (150.0–295.9) | 161.1 ms (135.8–393.9) |
| renderer script time, open → settled | 29.5 ms (23–42) | 27 ms (25–31) |
| listing heap | 9.40 MB (8.10–9.47) | 7.53 MB (6.18–7.63) |
| listing heap after the kind/icon pass | 10.11 MB | 8.27 MB |
| row bytes (heap snapshot) | 159 B/row, 14 fields | 91 B/row, 7 fields |
| Name ↓ sort | 46.3 ms (29.3–128.4) | 36.1 ms (29.1–104.5) |
| Date Modified ↓ sort | 39.2 ms | 38.9 ms |
| `fs:listDir` round trip | 92.6 ms (55.3–442.2) | 72.9 ms (64.0–1,175.2) |
| `fs:listDir` JSON | 3,000,112 B | 2,360,112 B |

Paired by round, first paint is faster with this change in 15 of 20 rounds (median
−19.6 ms); the ranges overlap, so read it as "no regression, modestly faster".
Date Modified ↓ and the open script time do not move beyond noise. What the change
reliably cuts is memory (listing heap −1.9 MB, 159 → 91 B per row) and the payload
(−21%). A listing now crosses the worker port instead of `ipcMain`, so the round trip
is a port hop either way; what shrank is the payload and the renderer's work
per row.

Memory soak (`SOAK_CYCLES=40`), same machine, both builds:

| metric | `main` | this change |
| --- | ---: | ---: |
| retained heap, start → end | 13.3 → 18.6 MB | 12.8 → 16.4 MB |
| growth per cycle (gate ≤ 0.25) | 0.134 MB | 0.089 MB |
| renderer script time per cycle | 267.8 ms | 260.8 ms |
| 600-image thumbnail fill | 1,946 ms, 68 ms script | 2,183 ms, 71 ms script |
| listing generations / duplicate rows | 1 / 0 | 1 / 4 |
| `fs:enrichEntries` per cycle | 0.3 | 0.3 |
| main event-loop p99 (gate < 16) | 13.8 ms | 14.2 ms |
| fs worker restarted | no | no |
