# AutoRAG Finder App

This repository is the standalone Electron Finder app: one repository, one
app. It is not a monorepo, and no other package is built or released from
here. Keep changes focused on `src/`, `test/`, `scripts/`, and repository
documentation. Do not add secrets, private corpus data, generated output, or a
vendored copy of another checkout.

## The librarian is a separate public repository

`@autorag/librarian` is not part of this repository. It is published in the
public AutoRAG repository (`github.com/Marker-Inc-Korea/AutoRAG`), whose
working checkout on this machine is `/Volumes/SSD1/1/AutoRAG`. Read that
checkout when a change needs librarian behavior, types, or builtin skill
names — it is a reference to consult, never a source of files to copy in. The
path is documentation for humans and agents only; it must never appear in
application code, config, or scripts.

The app consumes the librarian only through the dependency declared in
`package.json` (`@autorag/librarian: file:./.upstream/autorag`). That path
resolves inside the ignored `.upstream/autorag` clone, which
`scripts/sync-librarian.mjs` clones or fast-forwards to public `origin/main`
and builds. Never point the dependency at `file:..` or at the local
`/Volumes/SSD1/1/AutoRAG` checkout, never commit `.upstream`, and never copy
librarian sources into this repository.

## Development

Run from this directory:

```sh
bun install --frozen-lockfile
bun run dev
make run
bun run test
bun run typecheck
bun run build
```

`make run` launches the dev app through `bun run dev` on free ports, with the
main-process V8 inspector and the renderer remote-debugging endpoint enabled;
it prints the renderer URL and both debug endpoints before starting.

`preinstall`, `predev`, `pretest`, `pretypecheck`, and `prebuild` run
`scripts/sync-librarian.mjs`. That script fast-forwards the ignored
`.upstream/autorag` clone to public `origin/main`, builds the librarian when
the upstream HEAD or build artifacts change, and prints the exact HEAD. Never
replace the dependency with `file:..` or a local sibling path.

`dupey` is required for development and production builds. Set
`AUTORAG_SKIP_DUPEY_CHECK=1` only for an intentional degraded run.

## Workflow

Feature work and fixes never land straight on `main`. Start from the latest
`main`, work on a branch, and open a pull request:

```sh
git fetch origin
git switch main
git pull --ff-only origin main
git switch -c feat/<short-topic>
# ...edit, test, then:
git commit
git push -u origin HEAD
gh pr create --base main --fill
```

Push directly to `main` only for an explicit, maintainer-approved exception
(such as a documentation-only correction requested by the owner); mention the
exception in the commit message. Pull requests target `main` on this
repository's `origin`.

Do not use `git worktree` in this repository. Keep a single checkout and
switch branches in place.

## Source map

- `src/main/` — Electron main process and filesystem/search services.
- `src/preload/` — typed renderer bridge.
- `src/renderer/` — React Finder UI and state.
- `src/shared/` — process-boundary contracts.
- `test/` — Vitest unit tests.
- `scripts/` — dev tooling (`make run`, librarian sync, dupey check).
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
