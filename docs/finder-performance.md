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
(`src/main/file-icon.ts`). Linux keeps `app.getFileIcon`. This removes the
qlmanage process pool, its temp dirs, the 4 s `execFile` timeout, and the
Dock-tile/orphan leak with them.

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
and the controller coalesces those requests (`state/thumbnails.ts`) into one
`fs.enrichEntries` batch every 60 ms and patches the icons in place. A folder
larger than the cap now fills in as the user scrolls, in both the list and the
icon grid.

`run-qa-finder-thumbnail-scroll.mjs` is the gate: a 300-image folder (names
zero-padded so the bottom rows are exactly the ones past the 240 cap). Row 300
is proven unmounted before scrolling, then must show a thumbnail after scrolling
to the bottom, with qlmanage still at 0. Red on `main` (no thumbnail, qlmanage
spawned), green here — 3/3.
