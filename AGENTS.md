# Dazzi App

**Dazzi is this app's name; the full name is "Dazzi powered by AutoRAG".** Use
the full name where it fits and identifies the product — the window title, the
onboarding header, the About panel, notifications, and docs headlines — and the
short name **Dazzi** in running copy, menus, and labels (`APP_FULL_NAME` and
`APP_NAME` in `src/shared/app-info.ts`). "AutoRAG" on its own names the backend
the app consumes: `@autorag/librarian`, `@autorag/app`, the shared AutoRAG
config, and the `AutoRAGAgent`/`AutoRAGLite` classes keep their identifiers.
Do not rename those backend identifiers, and do not introduce a third product
name on a user-facing surface.

The logo is the sunflower-with-sunglasses mark. `build/` holds the app icon set
(`icon.icns`, `icon.ico`, `icon.png`, `icons/<size>.png`) and
`src/renderer/src/assets/dazzi-logo.png` is the transparent mark the renderer
draws; regenerate all of them from one transparent master rather than editing
one in isolation.

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
`package.json` (`@autorag/librarian: file:./.upstream/librarian-package`). That path
is a staging directory that `scripts/sync-librarian.mjs` fills from the ignored
`.upstream/autorag` clone, which it checks out at the pinned release tag
(`v2.10.4`, raised deliberately with the alignment changes a new librarian
release needs) and builds. The staging directory holds only what the librarian
publishes (`files` of its `package.json`, without devDependencies), so the install
resolves the librarian's dependencies into the app's one `node_modules` and
`@earendil-works/pi-*` exists once (pointing the dependency at the clone itself
nests a second copy). Never point the dependency at `file:..` or at the local
`/Volumes/SSD1/1/AutoRAG` checkout, never commit `.upstream`, and never copy
librarian sources into this repository.

## Development

Run from this directory:

```sh
make setup
bun install --frozen-lockfile
bun run dev
make run
bun run test
bun run typecheck
bun run build
```

`make setup` (wrapping `scripts/setup.mjs`) prepares a fresh clone: it checks
for bun, Node 24+, and dupey, then installs dependencies. `make run` runs a
lightweight `--ensure` preflight that installs dependencies only when
`node_modules` is missing, so it also works from a fresh clone without a prior
`make setup`.

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

Any change that can move pixels — a stylesheet, a component's `className`, an
icon — must be checked with the screenshot harness, not just the unit tests:

```sh
bun run build
bun scripts/manual-qa/run-qa-finder-visual-parity.mjs /tmp/parity/before
# ...change, then bun run build...
bun scripts/manual-qa/run-qa-finder-visual-parity.mjs /tmp/parity/after
bun scripts/manual-qa/compare-visual-parity.mjs /tmp/parity/before /tmp/parity/after
```

`DESIGN.md` §0 "Styling contract" explains the token bridge, the cascade layers,
and what the harness has caught. On an unchanged tree the harness is
byte-identical between runs; anything else is a real difference to explain.

## User-facing text and translations (i18n)

The app ships in four interface languages: Korean (the default), English,
Japanese, and Simplified Chinese (`APP_LANGUAGES` in
`src/shared/language-contract.ts`). Every string a user can see goes through
i18next. Never hardcode a user-facing string in any language: no literals in
JSX, `aria-label`/`title`/`placeholder`, toasts, dialogs, menus,
notifications, or error messages shown to the user.

- **Where strings live.** One dictionary per language in
  `src/shared/i18n/locales/{ko,en,ja,zh}.json`. Put a key under the namespace of
  the surface it belongs to (for example `settingsCore.general.*` for
  Settings → 일반, `main.*` for strings the main process shows). Reuse an
  existing key before adding one.
- **Every key in all four files, in the same change.** Write a real
  translation for each language; never copy the Korean text into `en`/`ja`/`zh`
  or leave a placeholder. Interpolate with `{{name}}` and use the same
  variables in all four.
- **Renderer.** Components use `const { t } = useTranslation()` (from
  `src/shared/i18n`) and `t("namespace.key", { name })`. Non-React code
  (`state/*.ts`) imports `t` from `src/shared/i18n/core`.
- **Main process and fs worker.** Import `t` from `src/shared/i18n/core` (no
  React). Its language follows the interface-language setting: main applies it
  at startup and on every change and passes it to the fs worker. A string built
  once at launch, such as an application-menu label, appears in the language
  set at launch.
- **Data that is translated later.** Store the key, typed as `LocaleKey`, and
  call `t` where the text is shown, not when the data is created.
- **Not translated.** Product and brand names (`APP_NAME`/`APP_FULL_NAME`, see
  the top of this file), file names, paths, and text that comes from the user,
  a document, or an external service.

`test/i18n.test.ts` fails when a key is missing in any language, the
interpolation variables differ, or Korean is left in `en`, `ja`, or `zh`.
Check new UI in at least two languages, because translations change line
length and layout.

## Release pipeline

`.github/workflows/release.yml` turns a published GitHub release into a macOS
`.dmg` and a Windows `.exe`. `scripts/release/` holds the pieces and
`docs/release.md` explains them: `stage-tools.mjs` fetches or builds the newest
dependency programs and the embedding model into `build/stage/<platform>/`,
`verify-bundle.mjs` runs each of them on a bare `PATH`, `electron-builder.config.mjs`
packs them into the app's `resources/`, and `smoke-installed.mjs` installs the
real artifact and launches it. At run time `src/main/bundled-tools.ts` puts
`resources/tools/bin` first on `PATH` and `src/main/seed-assets.ts` copies the
model into `~/.autorag`. Stage each platform on a matching host; never commit
`build/stage`, `build/.cache`, or `dist`. Signing credentials live only in GitHub
secrets.

## Windows QA

The manual-QA lanes run on Windows 11 as well as macOS. Build once, then run
the sweep from PowerShell or cmd:

```sh
bun run build
bun scripts/manual-qa/run-all.mjs                  # all lanes
bun scripts/manual-qa/run-all.mjs live-sync kind   # selected lanes
```

`scripts/manual-qa/platform.mjs` holds the cross-platform differences: repo
paths via `fileURLToPath`, a home env with `USERPROFILE`, the `chord()` key
modifier (`⌘` on macOS, `Ctrl` elsewhere), separator-agnostic basenames, and
macOS-only process tools that degrade to no-ops on Windows. Prerequisites are
Node 24+, Bun, `dupey`, and `ffmpeg` on `PATH`. Logs and `summary.json` land in
`.omo/evidence/win-qa/`; the same sweep runs in
`.github/workflows/qa-windows.yml`.

## Running the QA lanes in a macOS VM

The lanes drive a real Electron window, so on the developer's own Mac every run
takes over the mouse, keyboard, and focus. `bun run qa` avoids that by running
the sweep in a throwaway macOS VM (Tart, Apple Virtualization.framework) with
its own display, input session, home directory, and Trash. Use it instead of
calling `run-all.mjs` directly whenever the machine is a developer's Mac.

```sh
bun run qa                       # all lanes: a VM if a slot is free, else this machine
bun run qa kind live-sync        # selected lanes (names from run-all.mjs)
bun run qa -- --vm               # VM only: exit 2 instead of using this machine
bun run qa -- --host             # this machine only (a window WILL take focus)
bun run qa -- --skip-build       # reuse out/; refused when src/ is newer than out/
bun run qa:vm:setup              # build the golden image (once per machine)
bun run qa:vm:status             # golden image, running VMs, who holds each slot
bun run qa:vm:gc                 # destroy VMs left behind by a crashed run
```

### Which path a run takes

| Situation | What happens |
| --- | --- |
| A slot is free and the golden image exists | VM path: clone, boot headless, sync, run, pull evidence, destroy. |
| Both VM slots are busy | The run prints which VMs hold the slots, then the sweep runs on this machine and takes focus. Do not touch the keyboard or mouse until it ends, or retry later for a VM. |
| Not Apple Silicon macOS, `tart` missing, or no golden image | Same fallback, with the reason printed. |
| `--vm` and none of the above can be served | Exit code `2`; nothing runs. Use this in automation that must never take focus. |
| `--host` | Host path unconditionally. |

A VM run exits with the job's own code, so `0` means every lane passed; `75`
means the job passed inside the VM but its artifacts could not be pulled back
before the VM was destroyed, and `2` means `--vm` was demanded and no VM could
serve it. The host path is the unchanged `scripts/manual-qa/run-all.mjs`.

### Parallel branches and the two-VM limit

Apple's license allows two macOS VMs per host. Every checkout shares one slot
pool under `~/.autorag-qa/slots` (`AUTORAG_QA_HOME` moves it), built on atomic
`mkdir`, so any number of clones (one per branch) can call `bun run qa` at the
same time: at most two get a VM and the rest take the host path above. A run
does not queue or wait for a slot; waiting would stall an agent for the length
of someone else's sweep. A slot whose owning process died (including `kill -9`,
or a killed process its parent has not collected yet) is reclaimed by the next
`bun run qa` or `bun run qa:vm:gc`, which also destroys that run's VM; until
then the dead run's VM keeps running and holds one of the two macOS VMs. A
macOS VM running outside the pool (a hand-started one) counts against the
allowance of two.

Each run's VM is named `autorag-qa-run-<branch>-<id>`, so `tart list` shows
whose it is. Evidence is pulled to `~/.autorag-qa/runs/<vm-name>/evidence/`
(the VM's own `.omo/evidence`); the VM and its disk are deleted at the end of
a run, including after a failed lane, Ctrl-C, or `SIGTERM` (the sweep is
aborted at once and the evidence of lanes already finished is not pulled).

### Manual QA by an agent (Playwright scripts)

When asked to manually QA the app, drive the real built app with a Playwright
script and run it through the runner, not with `node`/`bun` directly:

```sh
bun run qa script tmp-qa.mjs                       # VM if a slot is free, else this machine
bun run qa script --vm --skip-build tmp-qa.mjs     # VM only; exit 2 if no slot (never takes focus)
bun run qa script tmp-qa.mjs --my-flag value       # everything after the file goes to the script
```

The runner builds, takes a slot, boots a fresh VM, syncs the checkout, runs the
script there with `bun`, pulls the artifacts back, and destroys the VM. The
script is plain ESM that uses the helpers lanes already use
(`scripts/manual-qa/launch-finder.mjs`: `launchFinder`, `finderWindow`;
`platform.mjs`: `chord`). It writes screenshots and notes to `process.env.QA_OUT`
and prints its findings to stdout; both come back under
`~/.autorag-qa/runs/<vm-name>/evidence/` (the same directory on the host path).

- **Look at the screenshots.** A passing script proves nothing about what the
  UI shows. Read the PNGs (copy them into the working tree first if your file
  reader cannot open `~/.autorag-qa`), and report what you saw, not what the
  script asserted.
- Use real Playwright input (`click`, `keyboard.press`, `type`), not DOM calls
  or evaluated JS, wherever a user would use the mouse or keyboard.
- The script must live inside the checkout (only the checkout is synced). Use a
  throwaway name such as `tmp-qa.mjs`, and delete it before committing.
- Each run starts from a fresh VM, so there is no state to clean up and no
  state to carry over: a script that needs fixtures creates them itself, in the
  guest's home. For several independent scenarios, run several scripts at once
  (two VMs at most; extra runs take the host path unless `--vm` is given).
- Expect roughly 70-95 seconds of fixed cost per run (clone, boot, sync,
  teardown) on top of the script; measured 68-93 s wall for a script that
  itself takes a few seconds.
- On the host path (`--host`, or when the slots are full and `--vm` was not
  given) the script drives the real desktop: its window takes focus and the
  fixtures it creates land in the developer's real home. Prefer `--vm`; when you
  must use the host path, point the script at a temporary home and user-data
  directory (`launchFinder({ userDataDir, env: { HOME: tmp } })`).

Measured on the developer's Mac (an otherwise busy machine whose other
checkouts were running their own lanes): during one `--vm` script run the
frontmost application stayed the same in all 29 samples taken every 2 s, the
pointer never moved, and no new Electron process appeared on the host. In a
control window of the same length without a VM run, other checkouts' Electron
lanes took the frontmost application in 27 of 43 samples.

### One-time setup

Prerequisites on the host: Apple Silicon Mac, [`tart`](https://tart.run)
(`brew install cirruslabs/cli/tart`, or the release tarball), `sshpass`
(`brew install sshpass`; the bootstrap login only), `rsync`, `python3`, and
about 60 GB of free disk. Then:

```sh
bun run qa:vm:setup              # about 30 minutes; --rebuild replaces the image
```

Setup pulls Cirrus Labs' `macos-tahoe-vanilla` image (about 25 GB, once),
boots Recovery and drives it over VNC (`vncdotool` in a private venv) to run
`csrutil disable`, then provisions the guest with
`scripts/qa-vm/provision-guest.sh` and renames the verified result to
`autorag-qa-golden`. A failed setup leaves `autorag-qa-golden-build` for
inspection and never touches an existing golden image. The VM image lives in
tart's storage (`TART_HOME`, default `~/.tart`); put it on a large disk by
writing `{ "tartHome": "/path" }` to `~/.autorag-qa/config.json`.

Each run authenticates with an ed25519 key generated into
`~/.autorag-qa/id_ed25519` and baked into the image. The image's `admin` /
`admin` login is Cirrus Labs' published default and exists only inside the VM,
on a NAT network no other machine can reach; do not reuse it anywhere else.

### Why the golden image looks the way it does

Each setting fixes a failure seen in the lanes, not a preference:

- **SIP off, system TCC grants for Screen Recording.** Without the grant
  `screencapture` fails with `could not create image from display` and the
  `quick-look-reference` lane cannot run. The system TCC database is only
  writable with SIP off, and grants written to the user database are ignored.
- **Rosetta.** Without it LaunchServices rejects a `.app` whose executable is
  not Mach-O (`open` fails with error `-10669`), which fails `app-bundles`.
- **Spotlight off.** With indexing on, `mdls` answers `(null)` for new files in
  `~/Documents` for minutes after a large sync, and the Kind column then shows
  the extension fallback (`Markdown` for `.mp4`) instead of the OS kind.
- **Dock auto-hide.** The work area changes by 1 px when the Dock first draws,
  which fails the Quick Look lane's exact-size assertion.
- **No sleep**, `ffmpeg`, Command Line Tools (git, swift for `os-drag.swift`),
  Node 24, bun, and `dupey` (built for the host and copied; `dupey` has to be
  on the host's `PATH` at setup).

### Pitfalls

- `out/` is built on the host and synced; the guest never builds. A stale
  `out/` tests old code, which is why `--skip-build` refuses when `src/` is
  newer. `node_modules` and `out/` are Apple Silicon builds, so the host and
  the VM must both be arm64.
- A lane that passes in a VM has not proven real-hardware behavior for things
  a VM cannot show (GPU rendering, a physical display, real Finder.app state).
  Run `--host` for those before release.
- A fresh VM has no embedding model. For the `onboarding` lane, a full sweep, or a
  `qa script`, the runner copies `models/` and `runtime/` from the host's
  `~/.autorag` (or `AUTORAG_HOME`) into the guest; without them the first index
  fails with "Embedding runtime assets are unavailable". Run `autorag models
  prefetch` on the host once.
- Never run `qa:vm:setup` while a run is active; setup needs both VM slots.
- Do not copy `~/.autorag-qa`, the golden image, or `evidence` into a
  repository. They are machine-local.

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

- `src/main/` — Electron main process: windows, menus, IPC, thumbnails, and
  the fs worker's lifecycle (`fs-worker-host.ts`). Its filesystem services
  (listing, watch, places, dupey, index status) run inside the fs worker.
- `src/main/agents/` — the factory for helper agents (plain pi sessions that
  share the AutoRAG agent's model and sign-in) and their profiles; see
  `docs/architecture.md` "Helper agents". AI Search itself stays on the librarian.
- `src/fs-worker/` — the "AutoRAG File System" utility process entry.
- `src/preload/` — typed renderer bridge; FS calls go straight to the worker
  over a MessagePort (`worker-link.ts`).
- `src/renderer/` — React Finder UI and state. Styled with Tailwind 4
  utilities: `styles/tokens.css` holds every design value, `styles/tailwind.css`
  bridges those tokens into Tailwind theme namespaces (`@theme inline`), and
  `styles/app.css` layers the remaining hand-written sheets below the utilities.
  Icons come from `lucide-react` through `components/icons.tsx`. See
  `DESIGN.md` §0 "Styling contract" before touching styles.
- `src/shared/` — process-boundary contracts.
- `test/` — Vitest unit tests.
- `scripts/` — dev tooling (`make run`, librarian sync, dupey check).
- `scripts/manual-qa/` — real Electron QA scripts.
- `scripts/qa-vm.mjs`, `scripts/qa-vm/` — the `bun run qa` runner: golden
  macOS VM image setup, the two-slot VM pool, and the VM/host path choice.

Keep bridge contract changes synchronized across the shared contract, IPC
registration, preload bridge, and both Finder source adapters.

The app test script explicitly excludes the ignored `.upstream/autorag`
checkout so it does not execute the librarian's tests from this app root.

## Constraints

- Do not commit `.upstream`, `node_modules`, `out`, `dist`, `.autorag`, or QA
  evidence.
- Do not send corpus text to remote embedders.
- Do not put tokens, cookies, API keys, or private paths in config or scripts.
