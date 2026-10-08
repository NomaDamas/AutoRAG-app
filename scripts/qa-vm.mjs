#!/usr/bin/env node
/**
 * Run the manual-QA lanes in an isolated macOS VM (or on this machine).
 *
 *   bun run qa                      all lanes; a VM if a slot is free, else this machine
 *   bun run qa kind live-sync       selected lanes
 *   bun run qa -- --vm              VM only: exit 2 instead of using this machine
 *   bun run qa -- --host            this machine only (a window will take focus)
 *   bun run qa -- --skip-build      reuse out/ (refused when src/ is newer)
 *   bun run qa:vm:setup             build the golden VM image, once per machine
 *   bun run qa:vm:status            golden image, running VMs, slot holders
 *   bun run qa:vm:gc                destroy VMs left behind by a crashed run
 *
 * See "Running the QA lanes in a VM" in AGENTS.md.
 */

import { fileURLToPath } from "node:url";
import { applyConfig } from "./qa-vm/config.mjs";
import { parseArgs } from "./qa-vm/plan.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");

applyConfig();

let options;
try {
	options = parseArgs(process.argv.slice(2).filter((arg) => arg !== "--"));
} catch (error) {
	process.stderr.write(`[qa:vm] ${error.message}\n`);
	process.exit(64);
}

switch (options.command) {
	case "setup": {
		const { setup } = await import("./qa-vm/setup.mjs");
		await setup({ rebuild: options.rebuild });
		break;
	}
	case "status": {
		const { status } = await import("./qa-vm/run.mjs");
		status();
		break;
	}
	case "gc": {
		const { gc } = await import("./qa-vm/run.mjs");
		await gc();
		break;
	}
	default: {
		const { run } = await import("./qa-vm/run.mjs");
		try {
			process.exitCode = await run({ root: ROOT, options });
		} catch (error) {
			process.stderr.write(`[qa:vm] ${error.message}\n`);
			process.exitCode = 1;
		}
	}
}
