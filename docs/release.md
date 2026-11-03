# Releasing Dazzi

Publishing a GitHub release builds two installers and attaches them to it:

| Platform | File | Install |
|---|---|---|
| macOS (Apple Silicon) | `Dazzi-<version>-arm64.dmg` | open, drag Dazzi to Applications |
| Windows (x64) | `Dazzi-Setup-<version>-x64.exe` | double-click; per-user, no admin prompt |

```sh
gh release create v1.2.3 --generate-notes      # builds and attaches both installers
gh workflow run release.yml -f version=v1.2.3-rc.1   # rehearsal: artifacts only, nothing published
```

The tag is the version. CI rewrites `package.json` and `APP_VERSION` from it
(`scripts/release/set-version.mjs`); nothing needs bumping by hand. A tag that
is not `vX.Y.Z` or `vX.Y.Z-suffix` fails the run before any build starts.

## Homebrew

```sh
brew install --cask nomadamas/dazzi/dazzi     # Apple Silicon
brew upgrade --cask dazzi                    # catches up with the newest release
```

The tap is [`NomaDamas/homebrew-dazzi`](https://github.com/NomaDamas/homebrew-dazzi). The `homebrew`
job of `release.yml` runs after the Mac dmg is on a stable (`vX.Y.Z`) release, whether built in CI or
locally, renders `Casks/dazzi.rb` with `scripts/release/render-cask.mjs` from the dmg's digest in
`SHA256SUMS-macos.txt` and pushes it to the tap, so brew serves the newest release as soon as it is
published. Pre-releases are skipped. The cask declares `auto_updates true`: the in-app updater keeps
working, and `brew upgrade --cask --greedy` also works.

The cask also links the `dazzi` command (`binary` stanza → `Contents/Resources/bin/dazzi`), and
the app links it itself on first start for dmg installs (`src/main/cli-install.ts`, see
`docs/architecture.md` "The `dazzi` command"). `build/cli/` is packed into `resources/bin` by
`extraResources`; `scripts/release/verify-bundle.mjs` does not need to know about it.

One-time setup: create a fine-grained PAT with *Contents: read and write* on `NomaDamas/homebrew-dazzi`
and store it: `gh secret set HOMEBREW_TAP_TOKEN --repo NomaDamas/AutoRAG-app`. Without it the job
skips. The cask is not notarization-dependent, but an unsigned dmg still triggers Gatekeeper's warning.

## What one installer contains

Everything the app needs besides the embedding model (downloaded on demand, see below), so a user
installs one file and nothing else:

| Component | Source | Notes |
|---|---|---|
| Dazzi app | this repo | Electron, unpacked (the bundled CLIs run under plain Node) |
| `autorag` (agent/CLI) | `@autorag/librarian`, public `origin/main` | built by `scripts/sync-librarian.mjs` |
| Node 24 LTS + npm | nodejs.org | runtime of the npm-based CLIs, checked against nodejs.org's SHASUMS |
| `minsync`, `rhwp`, `himalaya`, `rclone`, `lark-cli`, `discrawl`, `telecrawl`, `wacrawl` | newest GitHub release, per platform | download verified against the sha256 GitHub publishes for the asset. `minsync` also provides the `serve` loopback embedding server the app starts and stops; the stager refuses a build below 0.6.0 (`version-floors.mjs`) |
| `slacrawl`, `notcrawl` | newest GitHub release (macOS); built from the newest tag with Go (Windows, no archive published) | |
| `dupey`, `jikji`, `clawgallery` | newest crates.io release, compiled on the build machine | |
| `lazykatok` | newest GitHub release of `changeroa/lazykatok` (macOS only: KakaoTalk for macOS) | the release archive `lazykatok-<version>-aarch64-apple-darwin.tar.gz`, download verified against the sha256 GitHub publishes. The stager refuses a build below 0.3.3, the first with the OpenAI-compatible embedder, so it embeds through the daemon's OpenAI route |
| `fsearch-cli` | `NomaDamas/fsearch-mac` via its Homebrew tap (macOS only) | fast file-name index. Homebrew links it to `/opt/homebrew/...`, so the stager copies it with its 16 dylibs into `tools/{bin,lib}` and re-points them at `@executable_path/../lib`. Needs `brew install nomadamas/fsearch-mac/fsearch-mac` on the build Mac (the stager runs it if missing; it compiles GTK, so the first run is slow). GPL-2.0-or-later: license and notice ship in `tools/licenses/fsearch-mac` |
| `filee-cli` | the librarian's pinned release (`FILEE_CLI_VERSION` / `FILEE_CLI_ASSETS`), taken from `NomaDamas/filee-cli` — never resolved from `latest` | the conversion CLI behind the agent's `convert_files` tool. The librarian downloads this exact archive into its home on first use unless it finds the binary on `PATH`; staging it is what makes an offline install convert. It is a self-contained .NET program (an apphost plus its assemblies and `engines/`), so it ships as a folder: `tools/filee-cli`, linked from `tools/bin` on macOS (a relative symlink .NET resolves through the real path) and flattened into `tools/bin` on Windows (a real `filee-cli.exe` beside its siblings — never a `.cmd` shim Node cannot spawn). MIT; license and third-party notices in `tools/licenses/filee-cli`. **Filee's own engines are not bundled** (see below) |
| MinSync's SPLADE model `nlpai-lab/KURE-Sparse-nano` (299 MB) | Hugging Face, pinned by revision and sha256 in `src/shared/sparse-model.json` | every local search ranks with it, including keyword-only mode on machines too small for the dense model, so the installer carries it in `tools/models/<repoDir>` (Hugging Face hub layout). At every start `bundled-sparse-model.ts` seeds it into MinSync's model cache when the cache lacks it: a clone on APFS, a copy elsewhere, each file renamed into place and `refs/main` written last. Apache-2.0: LICENSE ships in `tools/licenses/kure-sparse-nano`. `verify-bundle.mjs` checks every file's hash and runs an offline sparse-only MinSync sync and Korean stem query from it |
| Everything + ES (Windows only) | the librarian's own `vendor/everything` | the Windows equivalent of fsearch; already inside the app, hash-checked and unpacked on first use |
| `mailcrawl`, `kordoc` | newest npm release, installed with the bundled Node | native add-ons are fetched for the bundled Node's ABI. `mailcrawl` — the stager refuses it below 0.2.2 — embeds through the daemon's OpenAI route |

The dense embedding model is **not** in the installer. The app downloads the pinned
`Qwen/Qwen3-Embedding-0.6B` files (~1.2 GB, sha256-verified, resumable) from
Hugging Face into MinSync's model cache (`~/.cache/minsync/models` on macOS,
`%LOCALAPPDATA%\minsync\models` on Windows, or `FASTEMBED_CACHE_DIR`) when the
user chooses local embedding in onboarding or switches to it in Settings
(`src/main/model-download.ts`), and the embedding daemon does not start until the
model is present. `stage-tools.mjs` still stages a copy under
`build/stage/<platform>/verify-model` for `smoke-installed.mjs`'s daemon check only; nothing
packages it.

"Newest" is resolved at build time, so each release ships current dependencies;
`filee-cli` is the exception and follows the librarian's own pin, so the staged
copy is the exact version (`FILEE_CLI_VERSION`) the librarian would otherwise
download. Three tools carry a hard version floor (`scripts/release/version-floors.mjs`, with
the reason for each): `minsync` ≥ 0.6.0, `@nomadamas/mailcrawl` ≥ 0.3.0,
`lazykatok` ≥ 0.3.3. All three reach the shared `minsync serve` embedding route;
`minsync` 0.6.0 replaces BM25 with SPLADE sparse retrieval and adds sparse-only indexes on top of 0.5.1's
durable stage protocol v2 and JSONL sync progress streaming, and `mailcrawl` 0.3.0 adds `--source files` local archive indexing. The stager fails
rather than ship an older one.
`components-<platform>.json` on the release lists exactly what shipped (name,
version, source, sha256), and the build fails rather than ship a download that
does not match its published digest.

### How the app uses them

* `resources/tools/bin` is put first on `PATH` at startup (`src/main/bundled-tools.ts`),
  so a tool the user already has never shadows the version that was tested with the app.
  The background refresh job (launchd / Task Scheduler) runs the app's own executable
  and applies the same `PATH` itself (`src/main/refresh-job.ts`); the OS job definition
  carries no tools path, which keeps the Task Scheduler command under its 261-character
  `/TR` limit.
* npm CLIs (`mailcrawl`, `kordoc`) and `autorag` are launched through a tiny
  native launcher (`scripts/release/shim`) that runs the bundled Node. Windows
  cannot spawn a script by name; this makes them real executables on both platforms.
* `convert_files` runs the bundled `filee-cli` through the same `PATH` entry, so
  the agent converts files with no download. `filee-cli`'s own engines
  (LibreOffice, Pandoc, FFmpeg, Ghostscript, calibre) are **not** bundled: the
  tool downloads one into its data directory the first time a conversion needs
  it, so those conversions still need network once, then work offline. Images,
  Markdown, PDF, HWP and the rest are handled by the libraries inside the binary.
* The native Qwen3 embedding model (`Qwen/Qwen3-Embedding-0.6B`) is not bundled.
  The app downloads it when the user chooses local embedding in onboarding or
  switches to it in Settings (`src/main/model-download.ts`): the pinned revision
  (`97b0c614be4d`) and its four files (`config.json`, `tokenizer.json`,
  `model.safetensors`, `refs/main`), each verified by SHA-256 as it arrives and
  resumed rather than restarted if the download is interrupted. They land in
  MinSync's native model cache (`~/.cache/minsync/models` on macOS,
  `%LOCALAPPDATA%\minsync\models` on Windows, or `FASTEMBED_CACHE_DIR`), never
  overwriting an existing entry, and the `minsync serve` daemon does not start
  until the model is present.
* Once the model is in place the app starts `minsync serve` itself —
  `--idle-timeout 0 --embedder native:Qwen/Qwen3-Embedding-0.6B`, MinSync's own
  loopback embedding server — and stops it at quit (`src/main/embedding-daemon.ts`).
  It is the one process that holds the weights: MinSync's own sync, the librarian's
  memory, the chat sidecars, discrawl, mailcrawl and lazykatok all reach it through
  the state files it publishes under `~/.cache/minsync/serve/`
  (`%LOCALAPPDATA%\minsync\serve` on Windows). mailcrawl (≥ 0.2.2) and lazykatok
  (≥ 0.3.3) use its OpenAI route, so none of them loads a second copy.
* Non-ASCII file names are signed decomposed (NFD). Finder writes names decomposed when
  a user drags the app out of the dmg, and the code seal compares names byte for byte:
  v0.1.1 signed kordoc's four Korean template names composed (NFC), passed `codesign`
  and Gatekeeper on a `ditto` copy, and was still "damaged" after a Finder drag (seal:
  "file added" + "file missing"). `afterPack` renames them with `decomposeNonAsciiNames`
  before signing, and `smoke-installed.mjs` fails a build with any name that is not NFD.
  APFS lookups ignore normalization, so code that opens the composed name still finds the file.

### Deliberately not bundled

* `llama.cpp` (`llama-server`) and the `Q8_0` GGUF embedding weights: the local model is served by MinSync's own `minsync serve` daemon (started and stopped by the app) directly on the downloaded `Qwen/Qwen3-Embedding-0.6B` safetensors — Metal on macOS, CPU on Windows — so no llama.cpp runtime or GGUF copy ships for embeddings.
* `filee-cli`'s conversion engines: LibreOffice, Pandoc, Ghostscript, FFmpeg and calibre. `filee-cli` itself ships so `convert_files` works offline; an engine is downloaded by the tool into its own data directory the first time a conversion needs one (for example DOCX → PDF, or any video or audio format), so that first conversion needs network and later ones do not.
* Other platforms' native add-ons. Intel Macs, Windows on ARM and Linux are not shipped, and `pruneNativeForPlatform` in `lib.mjs` deletes the prebuilt add-ons those targets need from the bundled npm tree on each staged platform.
## Install time

Budget: **5 minutes from running the installer to an installed, launchable app.** The model is not
bundled and nothing is copied or downloaded at install time, so the budget covers the installer step
alone. Measured with `scripts/release/smoke-installed.mjs`, which installs the real artifact and fails
above `AUTORAG_INSTALL_BUDGET_SECONDS` (default 300).

| | installer |
|---|---|
| macOS (Apple Silicon, this Mac) | 20 s |
| Windows 11, Defender real-time protection on (12 cores, NVMe) | 63-68 s (six more bare installs: 66-67 s); one run took 240 s (cause unknown) |

What made the Windows installer slow, measured on that PC: the installer wrote each of ~46,000 small
files twice (electron-builder's NSIS template extracts to a temp folder, then `CopyFiles` into the
install directory) at about 40 files/s, for 19-26 minutes. Defender was not the cause: excluding the
install directory, temp, and the installer process still took 13 minutes, with 31 s of Defender CPU.

The fix is in two parts:

* **One tar instead of 46,000 files.** `afterPack` packs `app/node_modules`, `tools/npm` and
  `tools/node` into `resources/payload.tar`; `build/installer.nsh` unpacks it with the system
  `System32\tar.exe` (bsdtar, Windows 10 1803+). The same tree extracted at about 1,000 files/s
  (46 s). macOS is a single `.app` copy and needs none of this.
* **Fewer files.** Source maps, `.d.ts` files and READMEs are never read at run time and were about
  half of the npm trees: 7,600 files removed from `tools/npm`, and the `files` globs in
  `electron-builder.config.mjs` drop the same kinds from the app. That glob also used to drop every
  `*.md`, including the librarian's four `SKILL.md` agent skills, which were missing from the
  packaged app; they are now included.

That 240 s run (installer 226 s) came right after the installer was built on the same PC and has not
reproduced in nine other installs (63-68 s), including a freshly copied installer file, so it is not a
first-scan effect. It is still under the 300 s budget; if CI sees it, suspect other load on the machine.

A new `Dazzi-Setup` is also smaller (1.17 GB) and the app no longer contains the renderer-only
libraries Vite already bundles.

## Runners

GitHub-hosted runners are currently refused for this repository ("recent account
payments have failed or your spending limit needs to be increased"), so the
workflow reads its runners from repository **variables** (Settings → Secrets and
variables → Actions → Variables), as JSON:

| Variable | Hosted (default) | Own machine |
|---|---|---|
| `RELEASE_RUNNER_MAC` | `"macos-26"` | `["self-hosted","macOS","ARM64"]` |
| `RELEASE_RUNNER_WIN` | `"windows-2022"` | `["self-hosted","Windows","X64","autorag-qa"]` |

Fix billing and leave both unset, or register your own machines. A Mac runner:

```sh
mkdir ~/actions-runner && cd ~/actions-runner
# download the macOS ARM64 runner from Settings → Actions → Runners → New self-hosted runner
./config.sh --url https://github.com/NomaDamas/AutoRAG-app --token <TOKEN> --labels macOS,ARM64
./svc.sh install && ./svc.sh start
```

The existing Windows runner (`win-ssh-pc`) already carries the `autorag-qa` label.
Release runs only on `release: published` and manual dispatch, both of which need
repository write access, so the safety rules in `docs/windows-runner.md` still hold.
Never add `pull_request` to this workflow.

A runner needs about 20 GB free and Rust, Go, Node 24, and Bun reachable (the
workflow installs them with `setup-*` actions where it can). A Mac runner that is
your daily machine will be busy for roughly 20 minutes per release.

## Signing (you have to do this once)

Without signing, both installers still work, but the OS warns:
macOS says the app "cannot be verified" (right-click → Open gets past it) and
Windows SmartScreen shows "Windows protected your PC". Signing removes both.
The workflow signs automatically when the secrets below exist; nothing in the
repository ever holds a credential.

### macOS: Developer ID signing and notarization

You already have a **Developer ID Application** certificate
(`Developer ID Application: Dongkyu Kim (M23FFWRBMY)`) in your login keychain.

1. Export it: Keychain Access → My Certificates → right-click the certificate →
   Export → `.p12`, with a password.
2. Create an App Store Connect API key (notarization): App Store Connect → Users
   and Access → Integrations → Team Keys → "+" with role *Developer*. Download
   `AuthKey_XXXXXXXXXX.p8` (downloadable once). Note the **Key ID** and **Issuer ID**.
3. Store the secrets (repository → Settings → Secrets and variables → Actions):

```sh
gh secret set MAC_CERTIFICATE_P12      --repo NomaDamas/AutoRAG-app < <(base64 -i Certificate.p12)
gh secret set MAC_CERTIFICATE_PASSWORD --repo NomaDamas/AutoRAG-app          # the .p12 password
gh secret set APPLE_API_KEY_P8         --repo NomaDamas/AutoRAG-app < <(base64 -i AuthKey_XXXXXXXXXX.p8)
gh secret set APPLE_API_KEY_ID         --repo NomaDamas/AutoRAG-app          # e.g. ABC123DEFG
gh secret set APPLE_API_ISSUER         --repo NomaDamas/AutoRAG-app          # UUID from the Keys page
```

With the certificate alone the app is signed (no "unidentified developer" prompt on
most Macs); with the API key as well it is also notarized and stapled, which is
what makes it open with no prompt at all. Notarization of a 2.8 GB app takes
several minutes.

### Windows: code signing

An unsigned installer is what Windows reports as "unknown publisher" (SmartScreen: "Windows
protected your PC"). The workflow signs with **Azure Artifact Signing** (formerly Trusted
Signing; Basic SKU, about $10/month) once all of the values below exist. electron-builder
then signs every `.exe` it packs: `Dazzi.exe`, the bundled tools under `resources/tools`,
`elevate.exe`, the uninstaller, and the installer.

1. **Eligibility.** Public Trust is open to *organizations* in South Korea; *individual*
   developers only in the US and Canada. A Korean 개인사업자 such as 노마다마스 applies through
   **Organization → Public** with its 사업자등록증명 (in date, issued within 12 months). Microsoft
   does not document sole proprietorships either way, and its pages disagree on a three-year
   history requirement (a Microsoft moderator answered "no minimum org age" in 2026-08; the MSIX
   guidance still says three years). 노마다마스 opened on 2026-10-06, so ask Azure Support before
   the first attempt: validation allows three document uploads, and a failed request cannot be
   retried with the same entity without support. The certificate's CN is the validated legal
   name exactly as registered (`노마다마스`); it cannot be customized.
2. **What validation asks for.** A paid (pay-as-you-go) subscription, not free or trial; the
   *Artifact Signing Identity Verifier* role on the account; a website of the business
   (`https://nomadamas.org`); primary and secondary mailboxes on that domain that accept external
   links (the domain's mail runs through Cloudflare Email Routing, so both must forward to a
   monitored inbox); the business identifier (사업자등록번호) and address exactly as on the
   certificate; and the representative's Microsoft Verified ID (government ID + face check).
   Processing takes 1–20 business days.
3. **Resources.** Register the `Microsoft.CodeSigning` provider, create an Artifact Signing
   account in *Korea Central* (endpoint `https://krc.codesigning.azure.net`), and after
   validation completes, a **Public Trust** certificate profile. Create an app registration
   with a client secret and give it the *Artifact Signing Certificate Profile Signer* role on
   the account.
4. **Store the values.** `AZURE_CODESIGN_PUBLISHER` is the certificate's CN as shown in the
   profile's subject preview:

```sh
gh secret set AZURE_TENANT_ID     --repo NomaDamas/AutoRAG-app
gh secret set AZURE_CLIENT_ID     --repo NomaDamas/AutoRAG-app
gh secret set AZURE_CLIENT_SECRET --repo NomaDamas/AutoRAG-app
gh variable set AZURE_CODESIGN_ENDPOINT  --repo NomaDamas/AutoRAG-app --body https://krc.codesigning.azure.net
gh variable set AZURE_CODESIGN_ACCOUNT   --repo NomaDamas/AutoRAG-app --body <account name>
gh variable set AZURE_CODESIGN_PROFILE   --repo NomaDamas/AutoRAG-app --body <certificate profile name>
gh variable set AZURE_CODESIGN_PUBLISHER --repo NomaDamas/AutoRAG-app --body 노마다마스
```

All seven or none: `scripts/release/windows-signing.mjs` fails the pack when only some are set,
so a typo in one name can never ship an unsigned installer. The publisher matters for updates as
well as for the install prompt: electron-builder writes it into `resources/app-update.yml` as
`publisherName`, and electron-updater then refuses an update installer whose certificate CN differs
(`ERR_UPDATER_INVALID_SIGNATURE`). Artifact Signing cannot report its CN at build time, so a signed
build without `AZURE_CODESIGN_PUBLISHER` would ship an updater that accepts any installer.

`smoke-installed.mjs` is the gate on Windows: with `AZURE_CODESIGN_PUBLISHER` set it fails unless
the installer and every installed `.exe` pass `Get-AuthenticodeSignature` as `Valid` with that CN,
and `app-update.yml` carries the `publisherName`. Without it the run prints how many executables are
unsigned and continues. Each run writes the results to `authenticode.json` in its evidence directory.

A signature removes "unknown publisher" at once; SmartScreen's "Windows protected your PC" can still
appear for a new certificate until downloads build reputation (Artifact Signing issues no EV
certificates). Alternatives: an OV/EV certificate from a CA on a cloud HSM (the config change is
`win.signtoolOptions`; EV skips the reputation wait), or shipping unsigned with the "More info → Run
anyway" step documented.

## Download distribution (optional Cloudflare R2 mirror)

GitHub Releases stays the canonical, free mirror, and both installers keep
being attached to every release. For uniform download speed worldwide the
workflow can additionally mirror the same files to a Cloudflare R2 bucket
behind a custom domain: R2 egress is free, so traffic costs only pennies of
storage, and the custom domain serves the objects through Cloudflare's CDN.
The sync step is release-only and switches on by itself when the configuration
below exists; without it the run skips the mirror and GitHub Releases remains
the only host.

The mirror is configured and live:

1. The bucket (`autorag-dl`) and its custom domain (`dl.nomadamas.org`, zone
   `nomadamas.org`) are provisioned; the domain is the production download
   host. Never publish a `*.r2.dev` development URL; it is rate-limited and
   not built for production.
2. `R2_ENDPOINT` (the account's S3 endpoint) and `R2_BUCKET` are repository
   variables; `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` are repository
   secrets holding an R2 API token with *Object Read & Write* scoped to
   `autorag-dl`.
3. To rotate that token, create a new one (dash.cloudflare.com → R2 → Account
   Details → Manage API Tokens; the secret access key is shown once), store
   it, then revoke the old one:

```sh
gh secret set R2_ACCESS_KEY_ID     --repo NomaDamas/AutoRAG-app
gh secret set R2_SECRET_ACCESS_KEY --repo NomaDamas/AutoRAG-app
```

If `https://dl.nomadamas.org/` answers with R2's "not publicly accessible"
404 page even though objects exist, the account's R2 purchase/billing
enablement is not finished — complete it in the R2 dashboard (Settings /
billing banner) and retry; the same enablement is what unblocks the API token
step above. After enabling it, keys that were requested while access was
still off can keep answering 404: R2's edge caches that negative lookup per
key. Re-uploading the same key (which the release sync effectively does) or
requesting a fresh key clears it. `v0-test.txt` at the bucket root is a
deliberate 20-byte canary for exactly this check.

After a release, the files land at `https://dl.nomadamas.org/v<version>/` —
`Dazzi-<version>-arm64.dmg`, `Dazzi-Setup-<version>-x64.exe`,
`components-<platform>.json`, the `SHA256SUMS-*` files, and the auto-update
payloads below. Each version is synced into its own prefix with
`Cache-Control: public, max-age=31536000, immutable`: an installer never
changes once uploaded, so the CDN may cache it forever and edge hits give the
same fast download everywhere. Range requests are supported, so interrupted
downloads resume. Keep both links on the download page — the CDN first, the
GitHub release as fallback — and verify checksums after download either way.

What this does not solve: China. Neither Cloudflare nor GitHub is reliably
reachable there; a China-hosted mirror (for example Alibaba Cloud OSS behind an
ICP-licensed domain) would be its own upload step and its own decision.

## Auto-update

The packaged app updates itself with `electron-updater` (generic provider)
from the R2 mirror. Only the changed parts of a release are downloaded: each
update payload ships with a `.blockmap` (content-defined chunks, 8–32 KB), and
the app fetches only the chunks its previous payload lacks.

### What a release publishes

| Path on `dl.nomadamas.org` | Cache | Contents |
|---|---|---|
| `v<version>/Dazzi-<version>-arm64.zip` + `.zip.blockmap` | immutable | macOS update payload (Squirrel.Mac installs from the zip; the dmg stays the first-install download) |
| `v<version>/Dazzi-Setup-<version>-x64.exe.blockmap` | immutable | Windows: the installer is the payload; its blockmap must come from the same build |
| `v<version>/feed/latest*.yml` | immutable | this release's feed, kept for rollback |
| `latest/latest-mac.yml`, `latest/latest.yml` | `no-cache` | the feed the app polls; entries point at `../v<version>/…` |

The update zip is not attached to the GitHub release (GitHub caps an asset at
2 GiB and the feed never points there). `scripts/release/update-feed.mjs`
rewrites electron-builder's feed into the `latest/` form, and the sync step
uploads the feed last, after everything it references.

A build gets a feed only when `AUTORAG_UPDATE_FEED_URL` is set at pack time;
the workflow sets it to `https://dl.nomadamas.org/latest/` whenever the R2
variables exist. That writes `resources/app-update.yml`. A local
`release:pack:*` without it has no `app-update.yml`, and that app never checks.
A pre-release tag (`v1.2.3-rc.1`) writes `<channel>-mac.yml` / `<channel>.yml`
and follows only that channel, so releases never pick it up.

Cloudflare's custom-domain edge answers a multi-range request
(`Range: bytes=0-1,5-6`) with 400 and a single range with 206 (measured), so
the feed sets `useMultipleRangeRequest: false` and the app fetches one range
per request.

### Policy

* One check 30 s after launch, then every 6 hours; Settings → 일반 → 앱 업데이트
  and the macOS app menu's "업데이트 확인…" check on demand.
  The sidebar footer's right-hand icon is always a download arrow: dim and inert
  while there is nothing to fetch (up to date, checking, failed, or a build that
  cannot update), emphasised and clickable once a newer version exists (it
  downloads in install mode, opens the installer link in notify mode), and
  restart-to-install once the download is staged.
  `scripts/manual-qa/run-qa-finder-app-update.mjs <Dazzi.app>` exercises that
  against a signed pack and a local feed (macOS, not part of `run-all`).
* "업데이트 자동 설치" on (the default): the update downloads in the background
  and installs when the app quits; a system notification says so once per
  version, and "지금 재시작" applies it at once. Off: the app reports the new
  version and downloads only when asked.
* A failed background check keeps the previous state; a failed check the user
  started is shown. The updater writes `updater.log` in Electron's logs folder,
  which is named after the package (`~/Library/Logs/@autorag/app`,
  `%APPDATA%\@autorag\app\logs`), including each blockmap plan
  (`Full: … To download: … (n%)`).

### Platform rules

* **macOS needs a Developer ID signature.** Squirrel.Mac refuses to install
  over an ad-hoc signed app. The app reads its own signature at startup
  (`codesign -dv`); an ad-hoc build only reports the new version and opens the
  dmg link in the browser ("설치 파일 받기"). Set the signing secrets above to
  turn on real updates.
* **macOS differential needs a previous zip.** The first update after a dmg
  install downloads the whole zip (there is nothing cached to diff against);
  every update after that is differential.
* **Windows** installs per-user with no prompt; the installer copies itself
  into the updater cache at install time, so even the first update is
  differential. Without Azure signing the app installs updates unverified
  (electron-updater checks the publisher only when the build is signed).

### Kill switch

To stop a bad release from spreading, point `latest/` back at the previous
version's feed; clients still on the old version then see nothing new
(clients that already updated stay on the bad version until a newer release):

```sh
aws s3 cp "s3://autorag-dl/v<previous>/feed/" s3://autorag-dl/latest/ --recursive \
  --endpoint-url "$R2_ENDPOINT" --cache-control no-cache
```

Ship the fix as a new, higher version; electron-updater never downgrades.

## Before the first release

1. Set the runner variables above (or fix billing).
2. Add the signing secrets you want.
3. Confirm the R2 mirror variables and secrets above are still present.
4. Run the rehearsal: `gh workflow run release.yml -f version=v0.1.0-rc.1`, download the
   artifacts, and install them on a clean machine.
5. `gh release create v0.1.0 --generate-notes`.

## Local build

```sh
bun install --frozen-lockfile
bun run build
node scripts/release/stage-tools.mjs            # ~15 min first time; cached under build/.cache
node scripts/release/verify-bundle.mjs build/stage/darwin-arm64/tools
bun run release:pack:mac                        # or release:pack:win on Windows
node scripts/release/smoke-installed.mjs        # installs dist/*.dmg|exe in a temp dir and launches it
```

Each platform is staged on a matching host: crates and npm add-ons are compiled
or fetched for the machine they run on. Needs Rust, Go (Windows only), and Node 24.

`scripts/release/stage-tools.mjs --only minsync,rhwp` re-stages just those tools.

## Local Mac release

A Mac with the Developer ID certificate in its login keychain builds, signs and
notarizes the dmg in about 20 minutes against roughly 35 on a hosted runner. Build it
there, attach it to a draft release, then publish; the workflow sees the dmg already
attached, skips its own Mac build (`macos`), and `mac-prebuilt` mirrors the local files to
R2 and points `latest/` at them. Windows still builds in CI. The Mac needs Xcode 26 or newer
(`actool --version`): electron-builder compiles `build/icon.icon` with it.

```sh
node scripts/release/set-version.mjs v1.2.3
AUTORAG_SKIP_DUPEY_CHECK=1 bun run build
GITHUB_TOKEN=$(gh auth token) node scripts/release/stage-tools.mjs
CSC_NAME="Dongkyu Kim (M23FFWRBMY)" APPLE_API_KEY=/path/AuthKey_<id>.p8 APPLE_API_KEY_ID=<id> \
  APPLE_API_ISSUER=<uuid> AUTORAG_UPDATE_FEED_URL=https://dl.nomadamas.org/latest/ bun run release:pack:mac
node scripts/release/smoke-installed.mjs
node scripts/release/update-feed.mjs dist feed
cp build/stage/darwin-arm64/tools/manifest.json dist/components-macos-arm64.json
(cd dist && shasum -a 256 *.dmg > SHA256SUMS-macos.txt)
gh release create v1.2.3 --draft --generate-notes dist/*.dmg dist/*.zip dist/*.zip.blockmap \
  dist/components-macos-arm64.json dist/SHA256SUMS-macos.txt feed/latest-mac.yml
gh release edit v1.2.3 --draft=false                # -> mac-prebuilt + windows
```

The update zip and feed are attached only as a hand-off to `mac-prebuilt`, which deletes
them from the release after the mirror, so a zip near GitHub's 2 GiB asset cap is fine
while it lasts. `smoke-installed.mjs` is the gate: it fails a dmg whose installed copy does
not match its seal, is not notarized, or carries a name a Finder copy would rewrite.
