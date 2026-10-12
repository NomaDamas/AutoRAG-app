# Third-party notices

AutoRAG is distributed under the **AGPL-3.0**. This file lists the third-party
components that ship inside the app's archive-extraction engine — the
`libarchive-wasm` WebAssembly build (7z, RAR, tar.bz2, tar.xz), the `lzma-wasm`
LZMA encoder behind 7z compression, and the JavaScript zip
path. **Every component below is permissively licensed and AGPL-3.0 compatible**
(MIT, BSD-2-Clause, Apache-2.0, zlib, 0BSD/public domain).

The wasm is a port of the C **libarchive** library built with **Emscripten**.
Its upstream build (`lib/Dockerfile` and `lib/build.bash` in
`ofk/libarchive-wasm`) compiles libarchive together with zlib, xz/liblzma,
bzip2, and OpenSSL 3.4.1, then links them into the wasm.

AutoRAG ships its **own rebuild** of that binary at `src/main/vendor/libarchive.wasm`,
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
  and the build links `-lssl -lcrypto`; Apache-2.0 is AGPL-3.0 compatible, so
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
  did contain OpenSSL 1.0.2/`libcrypto` code (its OpenSSL/SSLeay dual license is
  not AGPL-3.0 compatible), so it was removed.

## Programs and models bundled in the installers

The macOS and Windows installers ship these programs unmodified, as separate
executables the app starts as child processes (no linking). Exact versions for a
given release are in the `components-<platform>.json` file attached to it.

| Component | License |
|---|---|
| Node.js | MIT |
| npm | Artistic-2.0 |
| minsync, jikji, dupey, kordoc, mailcrawl, rhwp, rclone, lark-cli, qmd | MIT |
| discrawl, telecrawl, wacrawl, slacrawl, notcrawl | MIT |
| himalaya, clawgallery | Apache-2.0 |
| lazykatok (macOS only) | MIT |
| Everything and ES (Windows only; shipped inside `@autorag/librarian`) | MIT (+ PCRE BSD) |
| fsearch-cli from fsearch-mac (macOS only) and its libraries glib, pango, harfbuzz, ICU, PCRE2, freetype, ... | GPL-2.0-or-later (fsearch-cli); LGPL-2.1+, MIT, ICU, BSD (libraries) |
| llama.cpp (`llama-server` runtime) | MIT |
| Qwen3-Embedding-0.6B (GGUF Q8_0 weights) | Apache-2.0 |

`fsearch-cli` is GPL-2.0-or-later, and AutoRAG only starts it as a separate
program (no linking), so AutoRAG stays AGPL-3.0. Its license and notice are
installed in `resources/tools/licenses/fsearch-mac`. Source for the shipped
version: https://github.com/NomaDamas/fsearch-mac (tag in `components-macos-arm64.json`).
The bundled glib/pango/ICU libraries are unmodified Homebrew builds whose install
paths were rewritten so they load from the app.
