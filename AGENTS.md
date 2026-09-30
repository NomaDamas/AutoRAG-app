# AutoRAG Finder App

This is an independent repository containing the Electron Finder app. Keep
changes focused on `src/`, `test/`, `scripts/`, and repository documentation.
Do not add secrets, private corpus data, generated output, or a sibling
checkout.

## Development

Run from this directory:

```sh
bun install --frozen-lockfile
bun run dev
bun run test
bun run typecheck
bun run build
```

`preinstall`, `predev`, `pretest`, `pretypecheck`, and `prebuild` run
`scripts/sync-librarian.mjs`. That script fast-forwards the ignored
`.upstream/autorag` clone to public `origin/main`, builds the librarian when
the upstream HEAD or build artifacts change, and prints the exact HEAD. Never
replace the dependency with `file:..` or a local sibling path.

`dupey` is required for development and production builds. Set
`AUTORAG_SKIP_DUPEY_CHECK=1` only for an intentional degraded run.

## Source map

- `src/main/` — Electron main process and filesystem/search services.
- `src/preload/` — typed renderer bridge.
- `src/renderer/` — React Finder UI and state.
- `src/shared/` — process-boundary contracts.
- `test/` — Vitest unit tests.
- `scripts/manual-qa/` — real Electron QA scripts.

Keep bridge contract changes synchronized across the shared contract, IPC
registration, preload bridge, and both Finder source adapters.

The app test script explicitly excludes the ignored `.upstream/autorag`
checkout so it does not execute the librarian's tests from this app root.

## Constraints

- Do not commit `.upstream`, `node_modules`, `out`, `dist`, `.autorag`, or QA
  evidence.
- Do not send corpus text to remote embedders.
- Do not put tokens, cookies, API keys, or private paths in config or scripts.
