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

## Manual QA

The Finder QA scripts are under `scripts/manual-qa/`. Build first, then run a
script with `bun scripts/manual-qa/run-qa-finder-<topic>.mjs`. Evidence belongs
under `.omo/evidence/ai-finder-app/` and is ignored.
