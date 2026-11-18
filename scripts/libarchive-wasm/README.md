# libarchive-wasm build recipe

`src/main/vendor/libarchive.wasm` is the engine behind 7z, RAR, tar.bz2, and
tar.xz extraction. It replaces the `libarchive.wasm` that ships in the
`libarchive-wasm@1.2.0` npm package and is loaded by `src/main/archive-worker.mjs`
through the module's `wasmBinary` option; the npm package still supplies the
JavaScript glue and reader classes.

## Why it is rebuilt

The upstream build never calls `setlocale`, so the module runs in the ASCII
`"C"` locale. libarchive then cannot convert a non-ASCII entry name to UTF-8
and substitutes `*` for every character: `한글.txt` inside a 7z, RAR, or tar.xz
extracted as `**.txt`. The same bytes read correctly in `bsdtar` under a UTF-8
locale, which is how the cause was isolated.

With the locale fixed, a name libarchive cannot convert at all is still `NULL`
from `archive_entry_pathname_utf8`, and a reader handed `NULL` drops the entry:
the Quick Look listing and the extractor both skip an empty name. That is what
happens to the CP949 a Korean Windows tool writes into a ustar, cpio, or ISO 9660
stream, none of which can declare a charset (`tar --format ustar` on Windows
writes `한글` as `C7 D1 B1 DB`, not UTF-8). `archive_entry.patch` gives the
accessor a fallback: when the conversion fails it hands the stored bytes over the
only way a C string can carry them — one byte per character, each one above ASCII
written as the UTF-8 encoding of the same Latin-1 code point, so `C7 D1 B1 DB`
arrives as `ÇÑ±Û`. `src/main/archive-names.mjs` turns that back into the bytes and
decodes them (UTF-8, then EUC-KR), exactly as it already does for a zip name that
fflate read as Latin-1.

`libarchive.c` here is upstream's file (https://github.com/ofk/libarchive-wasm,
MIT, see `LICENSE.libarchive-wasm`) with one change: the first
`archive_read_new_memory` call runs `setlocale(LC_ALL, "C.UTF-8")`.
`archive_entry.patch` is one hunk of libarchive 3.7.7's `archive_entry.c`, which
the `Dockerfile` applies with `patch` before building the library — the only
local change to the Dockerfile. Otherwise the `Dockerfile`, `build.bash`, and
`exported_functions.json` are upstream's, unchanged: libarchive 3.7.7, zlib
1.3.1, xz 5.6.4, bzip2 1.0.8, emsdk 4.0.5. The built module has the same
imports and exports as the npm one, which is what lets it drop into the npm
glue.

## Rebuild

```sh
scripts/libarchive-wasm/build.sh
```

Needs Docker; the first run compiles OpenSSL, zlib, bzip2, xz, and libarchive
for wasm and takes about 30 minutes. The script overwrites
`src/main/vendor/libarchive.wasm`. The result is tied to the glue in
`libarchive-wasm@1.2.0` (the minified import names depend on the emscripten
version), so rebuild with the matching recipe whenever that dependency is
bumped. The minified names are also assigned per build: a change that makes a
new libarchive function reachable reshuffles them and the glue binds the wrong
function, so both C changes above deliberately stay inside functions the glue
already calls — after touching either, list an archive with
`test/preview-archive-list.test.ts` before publishing the wasm.
`test/archive-extract.test.ts` extracts Korean-named 7z and tar.xz fixtures and
fails if the locale patch is lost; it and `test/preview-archive-list.test.ts`
list a ustar whose Korean name is the CP949 Windows writes and fail if the
byte-preserving fallback is lost.
