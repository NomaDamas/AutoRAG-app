#!/usr/bin/env bash
# Mirror one platform's release files to the R2 bucket (docs/release.md → "Download distribution").
#
#   scripts/release/sync-r2.sh <tag> <upload-dir> <update-dir> [<feed-dir>]
#
# Installers and update payloads go to v<version>/ (immutable). The feed goes last, once everything it
# points at is downloadable: v<version>/feed/ keeps this release's copy for rollback, and latest/ (the
# feed the app polls and the landing page's /download/mac reads) is never cached.
# Needs R2_ENDPOINT, R2_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY; without them it skips.
set -euo pipefail

tag="$1" upload="$2" update="$3" feed="${4:-}"
if [ -z "${R2_ENDPOINT:-}" ] || [ -z "${R2_BUCKET:-}" ] || [ -z "${AWS_ACCESS_KEY_ID:-}" ]; then
	echo "no R2 endpoint/bucket/credentials configured: skipping the CDN mirror"
	exit 0
fi
prefix="s3://$R2_BUCKET/v${tag#v}"
immutable="public, max-age=31536000, immutable"
for dir in "$upload" "$update"; do
	aws s3 sync "$dir/" "$prefix/" --endpoint-url "$R2_ENDPOINT" --cache-control "$immutable"
done
if [ -n "$feed" ] && [ -d "$feed" ]; then
	aws s3 sync "$feed/" "$prefix/feed/" --endpoint-url "$R2_ENDPOINT" --cache-control "$immutable"
	aws s3 cp "$feed/" "s3://$R2_BUCKET/latest/" --recursive --endpoint-url "$R2_ENDPOINT" --cache-control "no-cache"
fi
