import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/**
 * The librarian's `wombat` client builds its child process environment from `process.env`, not from the `env` a test
 * hands to a service. A test that reached the real `wombat` therefore indexed the developer's real `~/.wombat` (it
 * once rewrote that catalog). Pointing wombat's data dir and config at an empty temp directory for the whole suite
 * means a stray run can only ever touch throwaway state; a test that wants a particular layout sets its own.
 */
const directory = mkdtempSync(join(tmpdir(), "autorag-test-wombat-"));
process.env.WOMBAT_DATA_DIR = join(directory, "data");
process.env.WOMBAT_CONFIG = join(directory, "config.toml");

afterAll(() => {
	rmSync(directory, { recursive: true, force: true });
});
