# Dazzi developer entry points.

.PHONY: setup run

# Prepare a fresh clone for development: verify the toolchain (bun, Node 24+,
# dupey), install dependencies (which clones and builds .upstream/autorag and
# downloads the Electron binary), and re-check the Electron binary. Idempotent:
# safe to re-run at any time.
setup:
	bun scripts/setup.mjs

# Launch the latest dev build on free ports, with the main-process V8
# inspector and the renderer remote-debugging endpoint enabled.
#
# The `--ensure` preflight installs dependencies only when they are missing, so
# `make run` works from a fresh clone (without running `make setup` first) and
# stays a fast no-op once the checkout is set up.
run:
	bun scripts/setup.mjs --ensure
	bun scripts/run-dev-debug.mjs
