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

`libarchive.c` here is upstream's file (https://github.com/ofk/libarchive-wasm,
MIT, see `LICENSE.libarchive-wasm`) with one change: the first
`archive_read_new_memory` call runs `setlocale(LC_ALL, "C.UTF-8")`. The
`Dockerfile`, `build.bash`, and `exported_functions.json` are upstream's,
unchanged: libarchive 3.7.7, zlib 1.3.1, xz 5.6.4, bzip2 1.0.8, emsdk 4.0.5.
The built module has the same imports and exports as the npm one, which is
what lets it drop into the npm glue.

## Rebuild

```sh
scripts/libarchive-wasm/build.sh
```

Needs Docker; the first run compiles OpenSSL, zlib, bzip2, xz, and libarchive
for wasm and takes about 30 minutes. The script overwrites
`src/main/vendor/libarchive.wasm`. The result is tied to the glue in
`libarchive-wasm@1.2.0` (the minified import names depend on the emscripten
version), so rebuild with the matching recipe whenever that dependency is
bumped. `test/archive-extract.test.ts` extracts Korean-named 7z and tar.xz
fixtures and fails if the locale patch is lost.
