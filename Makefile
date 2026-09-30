# AutoRAG Finder developer entry points.

.PHONY: run

# Launch the latest dev build on free ports, with the main-process V8
# inspector and the renderer remote-debugging endpoint enabled.
run:
	bun scripts/run-dev-debug.mjs
