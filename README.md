<div align="center">

<a href="https://dazziapp.com/"><img src="build/icons/256x256.png" width="128" height="128" alt="Dazzi logo"></a>

# Dazzi

**Ask your files.**

A Finder for your Mac that understands what's inside your documents, chats and mail.<br>
Dazzi powered by [AutoRAG](https://github.com/Marker-Inc-Korea/AutoRAG).

[![Website](https://img.shields.io/badge/dazziapp.com-f5b301?style=flat-square&logo=safari&logoColor=white)](https://dazziapp.com/)
[![Platform](https://img.shields.io/badge/macOS%20%C2%B7%20Windows-111111?style=flat-square&logo=apple&logoColor=white)](#releases)
[![License](https://img.shields.io/badge/license-FSL--1.1--MIT%20(Fair%20Source)-0a84ff?style=flat-square)](LICENSE)
[![Engine](https://img.shields.io/badge/engine-AutoRAG-7c3aed?style=flat-square&logo=github&logoColor=white)](https://github.com/Marker-Inc-Korea/AutoRAG)

[Website](https://dazziapp.com/) · [Features](#features) · [Develop](#develop) · [Architecture](docs/architecture.md) · [Design](DESIGN.md) · [Releases](docs/release.md)

<br>

<img src="https://dazziapp.com/assets/screens/finder-list-2400.webp" width="900" alt="Dazzi Finder list view: a studio folder with a version stack expanded and a PDF preview in the inspector">

</div>

<br>

## Features

<table>
<tr>
<td width="50%" valign="top">

### 🔎 Just ask

Ask the way you'd ask a teammate. Dazzi reads the files and writes back, with
every answer linked to the passages behind it. Drag files, folders or links
into a question to ask about just those.

</td>
<td width="50%" valign="top">

<img src="https://dazziapp.com/assets/screens/answer-crop-1400.webp" alt="A Dazzi answer summarizing the Seoul office lease terms, with citations">

</td>
</tr>
<tr>
<td width="50%" valign="top">

<img src="https://dazziapp.com/assets/screens/versions-crop-1600.webp" alt="Finder list with an invoice and its identical rescan stacked under one row">

</td>
<td width="50%" valign="top">

### 🌻 Spot the twins

`proposal-final`, `proposal-v3`, `proposal (1)`: stacked into one row, newest
on top, tagged **Latest**, **Similar** or **Identical**. Powered by
[dupey](https://crates.io/crates/dupey).

</td>
</tr>
<tr>
<td width="50%" valign="top">

### ⌨️ Space to see anything

Markdown, code, PDF, video, audio, Office and HWP/HWPX, previewed instantly in
Quick Look. HWP pages are drawn locally by
[rhwp](https://github.com/edwardkim/rhwp); Hancom Office is not required.

</td>
<td width="50%" valign="top">

<img src="https://dazziapp.com/assets/screens/ql-markdown-1400.webp" alt="Quick Look showing Markdown source beside the rendered page">

</td>
</tr>
<tr>
<td width="50%" valign="top">

<img src="https://dazziapp.com/assets/screens/panes-ai-2400.webp" alt="A folder pane beside an AI Search pane">

</td>
<td width="50%" valign="top">

### 🪟 A real Finder

Tabs and split panes: drag any tab to an edge to split, and every pane keeps
its own tabs, so a folder and an AI chat can sit side by side. Folders update
live as other apps change them.

</td>
</tr>
</table>

**And more:** hybrid keyword + meaning search reordered by a reranker ·
scheduled re-indexing that runs even while the app is closed · *Ask Dazzi* in
the Finder and Explorer right-click menu · light and dark mode · Korean,
English, Japanese and Simplified Chinese.

### Every place, one search

Connect the apps you already talk in; Dazzi searches them alongside your files.

<table>
<tr>
<td align="center" width="25%">💬<br><b>Slack</b><br>Channels and threads</td>
<td align="center" width="25%">💛<br><b>KakaoTalk</b><br>Chats on this Mac</td>
<td align="center" width="25%">🎮<br><b>Discord</b><br>Servers and forums</td>
<td align="center" width="25%">✈️<br><b>Telegram</b><br>Chats and channels</td>
</tr>
<tr>
<td align="center">📱<br><b>WhatsApp</b><br>Messages, read-only</td>
<td align="center">✉️<br><b>Mail</b><br>Every inbox you sign in to</td>
<td align="center">🐙<br><b>GitHub</b><br>Repos, issues, PRs</td>
<td align="center">🔮<br><b>Obsidian</b><br>Your vaults</td>
</tr>
</table>

### Private by design

- **Embedded on this Mac.** Document understanding runs on a local
  `Qwen/Qwen3-Embedding-0.6B` model. File contents are never sent to a remote
  embedder.
- **Keys stay encrypted.** Sign-in tokens and API keys live in the system's
  encrypted store, never in a config file.
- **Bring your own model.** Use Dazzi's managed models (Free, Air, Pro), or
  connect your own provider key and pay them directly.

## Develop

> [!NOTE]
> The librarian is **not** vendored. Lifecycle scripts clone the public
> AutoRAG repository into the ignored `.upstream/autorag` at the pinned
> release tag (`v2.10.3`), build it, and print the exact revision the app
> runs against.

**Prerequisites:** [Bun](https://bun.sh), Node.js 24+, and `dupey`
(`cargo install dupey --locked`).

```sh
make setup   # check toolchain, install dependencies (safe to re-run)
make run     # launch the dev app on free ports, debuggers enabled
```

| Command | What it does |
|---|---|
| `make setup` | Verifies bun, Node 24+ and dupey, then installs dependencies |
| `make run` | Starts the dev app; prints the renderer URL, main-process inspector, and renderer debug endpoint |
| `make onboarding` | Walks first-run onboarding in a disposable sandbox profile |
| `bun run test` | Vitest unit tests |
| `bun run typecheck` | TypeScript checks |
| `bun run build` | Production build into `out/` |
| `bun run qa` | Manual-QA lanes in a throwaway macOS VM (see [`AGENTS.md`](AGENTS.md)) |

`make run` also works from a fresh clone: it installs dependencies when
`node_modules` is missing. Use `PORT=9234 bun run dev` to pick the Vite port,
and `AUTORAG_SKIP_DUPEY_CHECK=1` only for an intentional run without version
grouping.

### Project layout

```text
src/main/        Electron main process: windows, menus, IPC, thumbnails
src/fs-worker/   "Dazzi File System" utility process: listing, watch, dupey
src/preload/     Typed renderer bridge (MessagePort to the fs worker)
src/renderer/    React Finder UI, Tailwind 4 + design tokens
src/preview/     Quick Look panel
src/shared/      Process-boundary contracts and i18n dictionaries
scripts/         Dev tooling, manual-QA lanes, release staging, QA VM
test/            Vitest unit tests
```

### Docs

| Document | Covers |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Settings, fs worker, onboarding, live sync, attachments, OS menus, QA lanes |
| [`DESIGN.md`](DESIGN.md) | Styling contract, tokens, components |
| [`docs/release.md`](docs/release.md) | Installers, bundled tools, signing |
| [`docs/finder-performance.md`](docs/finder-performance.md) | Listing and rendering performance |
| [`AGENTS.md`](AGENTS.md) | Contributor and agent rules, i18n, QA VM |

## Releases

Publishing a GitHub release builds `Dazzi-<version>-arm64.dmg` and
`Dazzi-Setup-<version>-x64.exe`. Each installer carries the app, every program
it drives, and the local embedding model, so one download is the whole install.

## License

Dazzi is [Fair Source](https://fair.io/) software released under
[**FSL-1.1-MIT**](LICENSE) (Functional Source License, Version 1.1, MIT Future
License): free to use, read, modify, and redistribute for any non-competing
purpose, and each release converts automatically to the MIT License two years
after publication. It is built on the open-source
[`@autorag/librarian`](https://github.com/Marker-Inc-Korea/AutoRAG) engine
(Apache-2.0). Bundled third-party components and their licenses are listed in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

<div align="center">
<br>
<sub>© 2026 <a href="https://github.com/NomaDamas">NomaDamas</a> · Screenshots are captured from the real app with a demo folder.</sub>
</div>
