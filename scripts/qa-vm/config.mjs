/**
 * Paths, names, and limits shared by the QA VM tooling.
 *
 * Everything machine-specific lives under `~/.autorag-qa` (override with
 * `AUTORAG_QA_HOME`): the SSH key baked into the golden image, the slot pool
 * shared by every checkout, run logs, and `config.json`. Nothing in it is
 * committed or copied into a checkout.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const QA_HOME = process.env.AUTORAG_QA_HOME ?? join(homedir(), ".autorag-qa");
export const CONFIG_FILE = join(QA_HOME, "config.json");
export const KEY_FILE = join(QA_HOME, "id_ed25519");
export const SLOTS_DIR = join(QA_HOME, "slots");
export const RUNS_DIR = join(QA_HOME, "runs");
export const VENV_DIR = join(QA_HOME, "venv");

/** The finished image every run clones. It only exists once `setup` completed. */
export const GOLDEN = "autorag-qa-golden";
/** The image under construction; renamed to GOLDEN as the last step of `setup`. */
export const BUILD = "autorag-qa-golden-build";
/** Every per-run VM starts with this, so leftovers are recognisable. */
export const RUN_PREFIX = "autorag-qa-run-";
/** Apple's license and kernel allow two macOS VMs per host. */
export const MAX_VMS = 2;

/** Public Cirrus Labs image credentials; the account only exists inside the VM. */
export const GUEST_USER = "admin";
export const GUEST_BOOTSTRAP_PASSWORD = "admin";
export const VANILLA_IMAGE = "ghcr.io/cirruslabs/macos-tahoe-vanilla:latest";
/** The checkout inside the guest, relative to its home directory. */
export const GUEST_REPO = "autorag-app";

/** Recovery-mode automation is written against this display size. */
export const VM_DISPLAY = "1440x900";
export const VM_CPU = Number(process.env.AUTORAG_QA_VM_CPU ?? 6);
export const VM_MEMORY_MB = Number(process.env.AUTORAG_QA_VM_MEMORY_MB ?? 12288);

/**
 * Read `config.json` and apply the tart storage location it recorded (an explicit `TART_HOME` wins).
 * The file is written by hand, per AGENTS.md; nothing in the tooling writes it.
 */
export function applyConfig() {
	let config = {};
	if (existsSync(CONFIG_FILE)) config = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
	if (config.tartHome && !process.env.TART_HOME) process.env.TART_HOME = config.tartHome;
	return config;
}
