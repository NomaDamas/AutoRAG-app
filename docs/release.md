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

## What one installer contains

Everything the app needs, so a user installs one file and nothing else:

| Component | Source | Notes |
|---|---|---|
| Dazzi app | this repo | Electron, unpacked (the bundled CLIs run under plain Node) |
| `autorag` (agent/CLI) | `@autorag/librarian`, public `origin/main` | built by `scripts/sync-librarian.mjs` |
| Node 24 LTS + npm | nodejs.org | runtime of the npm-based CLIs, checked against nodejs.org's SHASUMS |
| `minsync`, `rhwp`, `himalaya`, `rclone`, `lark-cli`, `discrawl`, `telecrawl`, `wacrawl` | newest GitHub release, per platform | download verified against the sha256 GitHub publishes for the asset |
| `slacrawl`, `notcrawl` | newest GitHub release (macOS); built from the newest tag with Go (Windows, no archive published) | |
| `dupey`, `jikji`, `clawgallery` | newest crates.io release, compiled on the build machine | |
| `lazykatok` | `changeroa/lazykatok` HEAD (macOS only: KakaoTalk for macOS) | no crates.io or release build exists |
| `fsearch-cli` | `NomaDamas/fsearch-mac` via its Homebrew tap (macOS only) | fast file-name index. Homebrew links it to `/opt/homebrew/...`, so the stager copies it with its 16 dylibs into `tools/{bin,lib}` and re-points them at `@executable_path/../lib`. Needs `brew install nomadamas/fsearch-mac/fsearch-mac` on the build Mac (the stager runs it if missing; it compiles GTK, so the first run is slow). GPL-2.0-or-later: license and notice ship in `tools/licenses/fsearch-mac` |
| Everything + ES (Windows only) | the librarian's own `vendor/everything` | the Windows equivalent of fsearch; already inside the app, hash-checked and unpacked on first use |
| `mailcrawl`, `qmd`, `kordoc` | newest npm release, installed with the bundled Node | native add-ons are fetched for the bundled Node's ABI |
| Qwen3-Embedding-0.6B (Q8_0) + llama.cpp runtime | the librarian's own pinned manifest | hash-checked at build time |

"Newest" is resolved at build time, so each release ships current dependencies.
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
* npm CLIs (`mailcrawl`, `qmd`, `kordoc`) and `autorag` are launched through a tiny
  native launcher (`scripts/release/shim`) that runs the bundled Node. Windows
  cannot spawn a script by name; this makes them real executables on both platforms.
* On first launch the embedding model and llama.cpp runtime are copied from
  `resources/seed` into `~/.autorag/{models,runtime}` (`src/main/seed-assets.ts`),
  verified by SHA-256, never overwriting an existing file. A fresh install indexes
  offline; there is no 650 MB download step. If seeding fails the librarian
  downloads the same pinned files on first use, as before.

### Deliberately not bundled

* CUDA builds of `node-llama-cpp` (500 MB, needs an NVIDIA toolkit); CPU and Vulkan are kept.
* Other platforms' native add-ons. Intel Macs, Windows on ARM and Linux are not shipped.

### Known limitation: embedder on Windows (upstream)

`ensureRuntime` in the librarian (`src/embedding-runtime/index.ts`) defaults its
platform to `darwin-arm64-metal` and never looks at `process.platform`. Measured
on the Windows installer's seeded files: `createEmbeddingRuntime({ platform: "win-x64-cpu" })`
starts llama-server and returns 1024-dimension Qwen3 vectors, but the default call
that MinSync makes fails with "Embedding runtime assets are unavailable". The
installer ships the correct Windows runtime and model, so the fix is one line
upstream (`platform ?? <derived from process.platform>`); until it lands, semantic
indexing on Windows reports the embedder as unavailable and falls back to BM25.
macOS is unaffected.

## Install time

Budget: **5 minutes from running the installer to a usable app, download excluded.** Measured with
`scripts/release/smoke-installed.mjs`, which installs the real artifact, launches it, waits for the
embedding model to be in place, and fails above `AUTORAG_INSTALL_BUDGET_SECONDS` (default 300).

| | installer | launch to model seeded | total |
|---|---|---|---|
| macOS (Apple Silicon, this Mac) | 20 s | 3 s | 22 s |
| Windows 11, Defender real-time protection on (12 cores, NVMe) | 63-68 s (six more bare installs: 66-67 s) | 13-15 s | 77-82 s; one run took 240 s (cause unknown) |

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
| `RELEASE_RUNNER_MAC` | `"macos-15"` | `["self-hosted","macOS","ARM64"]` |
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

Windows has no equivalent of a free certificate. Options, cheapest first:

1. **Azure Trusted Signing** (about $10/month, supported by the workflow). Create a
   Trusted Signing account and a certificate profile in Azure, complete identity
   validation (an organization with 3+ years of history, or an individual), create
   an app registration with the *Trusted Signing Certificate Profile Signer* role, then:

```sh
gh secret set AZURE_TENANT_ID     --repo NomaDamas/AutoRAG-app
gh secret set AZURE_CLIENT_ID     --repo NomaDamas/AutoRAG-app
gh secret set AZURE_CLIENT_SECRET --repo NomaDamas/AutoRAG-app
gh variable set AZURE_CODESIGN_ENDPOINT --repo NomaDamas/AutoRAG-app --body https://eus.codesigning.azure.net
gh variable set AZURE_CODESIGN_ACCOUNT  --repo NomaDamas/AutoRAG-app --body <account name>
gh variable set AZURE_CODESIGN_PROFILE  --repo NomaDamas/AutoRAG-app --body <certificate profile name>
```

2. A traditional OV/EV code-signing certificate from a CA. EV removes the SmartScreen
   warning immediately; OV and Azure builds earn reputation over some downloads.
   Since 2023 these private keys live on hardware tokens or cloud HSMs, so a plain
   `.pfx` secret is usually not possible; tell me which CA and the config is a small change.

3. Ship unsigned and document the SmartScreen "More info → Run anyway" step.

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
`AutoRAG-<version>-arm64.dmg`, `AutoRAG-Setup-<version>-x64.exe`,
`components-<platform>.json`, and the `SHA256SUMS-*` files. Each version is
synced into its own prefix with
`Cache-Control: public, max-age=31536000, immutable`: an installer never
changes once uploaded, so the CDN may cache it forever and edge hits give the
same fast download everywhere. Range requests are supported, so interrupted
downloads resume. Keep both links on the download page — the CDN first, the
GitHub release as fallback — and verify checksums after download either way.

What this does not solve: China. Neither Cloudflare nor GitHub is reliably
reachable there; a China-hosted mirror (for example Alibaba Cloud OSS behind an
ICP-licensed domain) would be its own upload step and its own decision.

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
