# Dazzi developer entry points.

.PHONY: setup run onboarding onboarding-skip-index

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

# Experience a brand-new user's first run on a disposable profile: one window,
# zero questions up front, one progress bar through scan → keyword-only index →
# tour → plans. Every run starts from scratch in a temp sandbox
# (userData, AutoRAG config/home/workspace), the real `~/.autorag` and the app's
# support dir stay untouched, and the sandbox is removed when the app exits —
# Ctrl+C, SIGKILL of this make, or the next run's sweep if both the wrapper and
# its watchdog died.
onboarding:
	bun scripts/setup.mjs --ensure
	bun scripts/run-dev-onboarding.mjs

# Same disposable first-run sandbox as `make onboarding`, with the setup stages
# stubbed (~2 s) so you land straight on "모두 준비되었어요!" → tour → plans
# without waiting for the real home-folder index.
onboarding-skip-index:
	bun scripts/setup.mjs --ensure
	bun scripts/run-dev-onboarding.mjs --skip-index
