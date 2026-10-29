# Third-party notices

Dazzi is [Fair Source](https://fair.io/) software distributed under
[**FSL-1.1-MIT**](LICENSE) (Functional Source License, Version 1.1, MIT Future
License), built on the Apache-2.0 `@autorag/librarian` engine. This file lists
the third-party components that ship inside the app's archive-extraction engine
— the `libarchive-wasm` WebAssembly build (7z, RAR, tar.bz2, tar.xz), the
`lzma-wasm` LZMA encoder behind 7z compression, and the JavaScript zip path.
**Every component below is permissively licensed** (MIT, BSD-2-Clause,
Apache-2.0, zlib, 0BSD/public domain).

The wasm is a port of the C **libarchive** library built with **Emscripten**.
Its upstream build (`lib/Dockerfile` and `lib/build.bash` in
`ofk/libarchive-wasm`) compiles libarchive together with zlib, xz/liblzma,
bzip2, and OpenSSL 3.4.1, then links them into the wasm.

Dazzi ships its **own rebuild** of that binary at `src/main/vendor/libarchive.wasm`,
loaded in place of the npm package's `dist/libarchive.wasm`. The only source
change is one `setlocale(LC_ALL, "C.UTF-8")` call in `libarchive.c`, which
makes non-ASCII (Korean) entry names readable; the Dockerfile and build flags are
upstream's unchanged. The full recipe, with upstream's MIT license text, is in
`scripts/libarchive-wasm/` and rebuilds with `scripts/libarchive-wasm/build.sh`.
The `strings` inspection below was repeated on this rebuilt binary with the
same result.

Inspection of the **shipped** `dist/libarchive.wasm` (via `strings` and the
runtime's own version banner) found no `unrar`, `ZSTD_`, `LZ4_`, or `LZO_`
symbols, and no `openssl`/`evp`/`libcrypto` symbol or OpenSSL assertion string
at all — see the notes below. The runtime reports:
`libarchive 3.7.7 zlib/1.3.1 liblzma/5.6.4 bz2lib/1.0.8`.

| Component | Version | License | Copyright / source |
|---|---|---|---|
| libarchive | 3.7.7 | BSD-2-Clause | The libarchive project (Tim Kientzle and contributors) — https://github.com/libarchive/libarchive |
| zlib | 1.3.1 | Zlib | Jean-loup Gailly and Mark Adler — https://zlib.net |
| XZ Utils / liblzma | 5.6.4 | 0BSD (public-domain-style) | Lasse Collin — https://tukaani.org/xz |
| bzip2 | 1.0.8 | bzip2 (BSD-style, permissive) | Julian Seward — https://sourceware.org/bzip2 |
| OpenSSL | 3.4.1 | Apache-2.0 | The OpenSSL Project — https://www.openssl.org (see note) |
| Emscripten runtime and musl libc | (emsdk 4.0.5) | MIT / University of Illinois/NCSA | Emscripten and musl contributors |
| libarchive-wasm (JS wrapper + `libarchive.c`) | 1.2.0 | MIT | ofk — https://github.com/ofk/libarchive-wasm |
| fflate | 0.8.x | MIT | Arjun Barrett — https://github.com/101arrowz/fflate |
| lzma-wasm (7z compression) | 1.0.7 | MIT OR Apache-2.0 | Aluria — https://github.com/Wu-Yijun/lzma-wasm |
| lzma-rust2 (compiled into lzma-wasm) | 0.16.2 (its lockfile) | Apache-2.0 | https://github.com/hasenbanck/lzma-rust2 |
| sha2, digest, block-buffer, crypto-common, generic-array, typenum, cfg-if, once_cell, wasm-bindgen, version_check, cpufeatures, libc (Rust crates in lzma-wasm's lockfile) | various | MIT or MIT OR Apache-2.0 | crates.io |

Notes on what was verified:

- **OpenSSL 3.4.1 (Apache-2.0).** The upstream Dockerfile fetches OpenSSL 3.4.1
  and the build links `-lssl -lcrypto`; Apache-2.0 is a permissive license, so
  this is fine either way. Independently, `strings dist/libarchive.wasm` finds
  **zero** OpenSSL/`evp`/`libcrypto` hits, so the shipped binary does not appear
  to reference it (the linker pulled in no crypto objects for this feature set).
  Encrypted archives are refused rather than decrypted.
- **unRAR is absent.** RAR is extracted by libarchive's own RAR v4/v5 readers
  (BSD-2-Clause, clean-room, written from the public format description). No
  RARLAB unRAR source is linked, and there is no 7-Zip unRAR code (the reason
  `7z-wasm` was not used). RAR is extract-only: the format is proprietary and
  RARLAB's license forbids building a RAR compressor, so none is offered.
- **No zstd, lz4, or lzo**: absent from the upstream build (`--without-lz4`,
  `--without-lzo2`) and from the shipped wasm symbols.
- `libarchive-wasm` replaces `libarchive.js`: the shipped `libarchive.js` wasm
  did contain OpenSSL 1.0.2/`libcrypto` code (OpenSSL/SSLeay dual license), so
  it was replaced with the clean rebuild above.

## Quick Look dependencies

| Component | Version | License | Use |
|---|---|---|---|
| cfb (SheetJS) | 1.2.2 | Apache-2.0 | Reads the OLE2 container of Outlook `.msg` files in Quick Look; also pulled in by `xlsx` and `kordoc` |
| pdf-lib (and `@pdf-lib/standard-fonts`, `@pdf-lib/upng`) | 1.17.1 | MIT | Andrew Dillon — https://github.com/Hopding/pdf-lib (PDF 1.5 object-stream compaction and embedded image stream rewriting in Reduce Size) |

## Bundled typeface

| Component | Version | License | Copyright / source |
|---|---|---|---|
| Pretendard Variable (`PretendardVariable.woff2`) | 1.3.9 | SIL Open Font License 1.1 | Kil Hyung-jin, with Reserved Font Name Pretendard — https://github.com/orioncactus/pretendard |

The font file ships unmodified as the app's UI typeface
(`src/renderer/styles/fonts/`). The full license text is in
`src/renderer/styles/fonts/Pretendard-OFL.txt`.

## Programs and models bundled in the installers

The macOS and Windows installers ship these programs unmodified, as separate
executables the app starts as child processes (the app links none of them).
`minsync` itself statically links one LGPL library, `kiwi-rs`; see below. Exact
versions for a given release are in the `components-<platform>.json` file
attached to it.

| Component | License |
|---|---|
| Node.js | MIT |
| npm | Artistic-2.0 |
| minsync, jikji, dupey, kordoc, mailcrawl, rhwp, rclone, lark-cli | MIT |
| discrawl, telecrawl, wacrawl, slacrawl, notcrawl | MIT |
| himalaya, clawgallery | Apache-2.0 |
| filee-cli (NomaDamas' redistribution of KnifeLemon/Filee's command line; see below) | MIT |
| lazykatok (macOS only) | MIT |
| Everything and ES (Windows only; shipped inside `@autorag/librarian`) | MIT (+ PCRE BSD) |
| fsearch-cli from fsearch-mac (macOS only) and its libraries glib, pango, harfbuzz, ICU, PCRE2, freetype, ... | GPL-2.0-or-later (fsearch-cli); LGPL-2.1+, MIT, ICU, BSD (libraries) |
| Qwen/Qwen3-Embedding-0.6B (safetensors weights + tokenizer) | Apache-2.0 |
| Kiwi native library and base model (`resources/tools/kiwi`): 0.24.0 on macOS, 0.22.2 on Windows | Apache-2.0 (0.24.0); LGPL-2.1-or-later (0.22.2) |

`fsearch-cli` is GPL-2.0-or-later, and Dazzi only starts it as a separate
program (no linking), per mere aggregation. Its license and notice are
installed in `resources/tools/licenses/fsearch-mac`. Source for the shipped
version: https://github.com/NomaDamas/fsearch-mac (tag in `components-macos-arm64.json`).
The bundled glib/pango/ICU libraries are unmodified Homebrew builds whose install
paths were rewritten so they load from the app.

### Kiwi and kiwi-rs

`minsync` tokenizes Korean for its keyword index with the Kiwi morphological
analyzer. The Kiwi native library and its base model ship in
`resources/tools/kiwi` as separate files that `minsync` loads at run time; the
app does not link them. Source: https://github.com/bab2min/Kiwi. The models
were trained on the Sejong and NIKL corpora, which are not distributed.

- **macOS: Kiwi 0.24.0**, Apache-2.0 (library and model). Its LICENSE and NOTICE
  are installed in `resources/tools/licenses/kiwi`.
- **Windows: Kiwi 0.22.2**, LGPL-2.1-or-later, **unmodified**: `kiwi.dll` and the
  model are the official `kiwi_win_x64_v0.22.2.zip` and `kiwi_model_v0.22.2_base.tgz`
  release assets, not rebuilt or repackaged, with their SHA-256 in
  `components-win32-x64.json`. Kiwi's LICENSE, the LGPL-2.1 text
  (`LGPL-2.1.txt`) and a `SOURCE.txt` are installed in
  `resources/tools/licenses/kiwi`. `SOURCE.txt` states that nothing was changed
  and gives the complete corresponding source, which is equivalent access from
  a designated place (LGPL-2.1 sections 4 and 6(d)):
  https://github.com/bab2min/Kiwi/tree/v0.22.2 (its `third_party/` directory is
  git submodules and its models are Git LFS objects, so use a recursive clone
  with Git LFS). The DLL is loaded from its own file at run time, so it can be
  replaced with a modified, interface-compatible build by setting
  `KIWI_LIBRARY_PATH` (section 6(b)); users may modify it for their own use and
  reverse engineer the app to debug such modifications. Kiwi 0.22.2 is used on
  Windows because 0.23.x and later crashed with MinSync on Windows in our test
  (see `docs/release.md`).

`minsync` reaches the library through the `kiwi-rs` crate 2026.8.26
(https://crates.io/crates/kiwi-rs, source https://github.com/JAICHANGPARK/kiwi-rs),
which is licensed LGPL-2.1-or-later and is statically linked into the `minsync`
executable, unmodified. MinSync is MIT licensed and its complete source is
public (https://github.com/NomaDamas/MinSync), so the executable can be rebuilt
against a modified `kiwi-rs`; see its `THIRD_PARTY_NOTICES.md` for the
instructions. Users may modify `kiwi-rs` for their own use and reverse engineer
the result to debug those modifications. The LGPL-2.1 text:
https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html

`mailcrawl` uses Kiwi through the `kiwi-nlp` npm package (WebAssembly). Version
0.23.x of that package is LGPL-2.1-or-later and is not linked into `mailcrawl`'s
own code; it is a separate package loaded at run time.

### filee-cli

`convert_files` runs `filee-cli`, NomaDamas' CLI-only redistribution of the
command line of [Filee](https://github.com/KnifeLemon/Filee). It is **MIT**:
Copyright (c) 2026 Myeonggu Kim (KnifeLemon) and Filee contributors for Filee,
and Copyright (c) 2026 NomaDamas for the build and packaging scripts,
documentation and CI of filee-cli. Dazzi ships it unmodified, pinned to the
version the librarian itself would download (`FILEE_CLI_VERSION`), as a separate
program started by the librarian; the app links nothing into it. Source:
https://github.com/NomaDamas/filee-cli — an **unofficial redistribution** of
upstream `v2.0.0` (commit `799e3948`) plus the single patch its `UPSTREAM.md`
lists, built from `src/Filee.Cli` with `Filee.Core` and `Filee.Engines` and
nothing else. Its `LICENSE` and `THIRD-PARTY-NOTICES.md` (the dotnet runtime and
every NuGet library it carries, with their license texts, including LGPL 7-Zip
and ImageMagick delegates in separate replaceable files) are installed in
`resources/tools/licenses/filee-cli`. `filee-cli`'s own conversion engines
(LibreOffice, Pandoc, FFmpeg, Ghostscript, calibre) are **not** included: it
downloads one from the vendor's own site the first time a conversion needs one,
as a separate program it starts with command-line arguments.

## Quick Look data viewers

| Component | License | Source |
|---|---|---|
| hyparquet, hyparquet-compressors | MIT | Hyperparam — https://github.com/hyparam/hyparquet |
| hyparquet-writer (tests and QA fixtures only) | MIT | Hyperparam — https://github.com/hyparam/hyparquet-writer |
