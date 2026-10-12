#!/usr/bin/env bash
# Rebuild src/main/vendor/libarchive.wasm from this directory's recipe.
# See README.md for what is patched and why.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/lib/build"
cp "$here/Dockerfile" "$work/Dockerfile"
cp "$here/build.bash" "$here/libarchive.c" "$here/exported_functions.json" "$work/lib/"

docker build -t autorag-libarchive-wasm-build -f "$work/Dockerfile" "$work"
docker run --rm -v "$work/lib:/workdir" autorag-libarchive-wasm-build ./build.bash

cp "$work/lib/build/libarchive.wasm" "$repo/src/main/vendor/libarchive.wasm"
shasum -a 256 "$repo/src/main/vendor/libarchive.wasm"
