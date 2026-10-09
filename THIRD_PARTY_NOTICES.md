# Third-party notices

AutoRAG is distributed under the **AGPL-3.0**. This file lists the third-party
components that ship inside the app's archive-extraction engine — the
`libarchive-wasm` WebAssembly build (7z, tar.bz2, tar.xz) and the JavaScript zip
path. **Every component below is permissively licensed and AGPL-3.0 compatible**
(MIT, BSD-2-Clause, Apache-2.0, zlib, 0BSD/public domain).

The wasm is a port of the C **libarchive** library built with **Emscripten**.
Its upstream build (`lib/Dockerfile` and `lib/build.bash` in
`ofk/libarchive-wasm`) compiles libarchive together with zlib, xz/liblzma,
bzip2, and OpenSSL 3.4.1, then links them into the wasm.

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

Notes on what was verified:

- **OpenSSL 3.4.1 (Apache-2.0).** The upstream Dockerfile fetches OpenSSL 3.4.1
  and the build links `-lssl -lcrypto`; Apache-2.0 is AGPL-3.0 compatible, so
  this is fine either way. Independently, `strings dist/libarchive.wasm` finds
  **zero** OpenSSL/`evp`/`libcrypto` hits, so the shipped binary does not appear
  to reference it (the linker pulled in no crypto objects for this feature set).
  Encrypted archives are refused rather than decrypted.
- **unRAR is absent.** libarchive's own RAR v4/v5 readers are BSD-2-Clause;
  there is no 7-Zip unRAR code (the reason `7z-wasm` was not used). RAR is not
  an offered extraction format.
- **No zstd, lz4, or lzo**: absent from the upstream build (`--without-lz4`,
  `--without-lzo2`) and from the shipped wasm symbols.
- `libarchive-wasm` replaces `libarchive.js`: the shipped `libarchive.js` wasm
  did contain OpenSSL 1.0.2/`libcrypto` code (its OpenSSL/SSLeay dual license is
  not AGPL-3.0 compatible), so it was removed.
