/**
 * A machine-wide pool of VM slots.
 *
 * macOS allows at most two macOS VMs per host, and several clones of this
 * repository (one per branch) may ask for one at the same time, so the pool
 * lives outside any checkout and is built on `mkdir`: creating a directory is
 * atomic, so exactly one process wins each slot even across processes.
 *
 * A slot is a directory holding `owner.json` (who took it and which VM it
 * runs). A slot whose owner process is gone is stale; the next caller reclaims
 * it and reports the dead owner through `onReap`, so its VM can be destroyed.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OWNER_FILE = "owner.json";
const SLOT_NAME = /^slot-(\d+)$/;

/** `ps` fields for one process, or null when it does not exist. */
function processInfo(pid) {
	try {
		const line = execFileSync("ps", ["-o", "stat=,lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
		if (line === "") return null;
		const stat = line.split(/\s+/, 1)[0];
		return { stat, start: line.slice(stat.length).trim() };
	} catch {
		return null;
	}
}

/** The start time of a process, so a recycled pid is not mistaken for its previous owner. */
function processStart(pid) {
	return processInfo(pid)?.start ?? "";
}

/**
 * True while the process that took a slot is still the same live process. A
 * zombie (killed, but its parent has not collected it) is dead: `kill(pid, 0)`
 * still succeeds on one, which would pin the slot until the parent exits.
 */
export function ownerAlive(owner) {
	const info = processInfo(owner.pid);
	return info !== null && !info.stat.startsWith("Z") && info.start === owner.procStart;
}

/** @typedef {{ pid: number, procStart?: string, acquiredAt?: number, [key: string]: unknown }} Owner */

/**
 * @param {object} options
 * @param {string} options.dir Directory that holds the slot directories.
 * @param {(owner: Owner) => boolean} [options.isAlive] Liveness of a slot's owner.
 * @param {(owner: Owner | null) => void} [options.onReap] Called with a reclaimed slot's dead owner.
 * @param {number} [options.pid] The pid recorded as owner (tests only).
 * @param {() => number} [options.now] Clock (tests only).
 * @param {number} [options.graceMs] How long a slot without `owner.json` counts as being created.
 */
export function createSlotPool({ dir, isAlive = ownerAlive, onReap = () => {}, pid = process.pid, now = Date.now, graceMs = 10_000 }) {
	mkdirSync(dir, { recursive: true });
	const slotPath = (index) => join(dir, `slot-${index}`);

	function readOwner(path) {
		try {
			return JSON.parse(readFileSync(join(path, OWNER_FILE), "utf8"));
		} catch {
			return null;
		}
	}

	/** An owner that died, or a slot directory abandoned before it recorded one. */
	function isStale(path) {
		const owner = readOwner(path);
		if (owner !== null) return !isAlive(owner);
		try {
			return now() - statSync(path).mtimeMs > graceMs;
		} catch {
			return false;
		}
	}

	/** Move a stale slot aside (atomic, so one caller wins), then delete it. */
	function reclaim(path) {
		const aside = `${path}.stale-${pid}-${now()}`;
		try {
			renameSync(path, aside);
		} catch {
			return;
		}
		const owner = readOwner(aside);
		rmSync(aside, { recursive: true, force: true });
		onReap(owner);
	}

	function tryTake(index, owner) {
		const path = slotPath(index);
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				mkdirSync(path);
			} catch (error) {
				if (error.code !== "EEXIST") throw error;
				if (isStale(path)) {
					reclaim(path);
					continue;
				}
				if (existsSync(path)) return null;
				continue;
			}
			const record = { ...owner, pid, procStart: processStart(pid), acquiredAt: now() };
			writeFileSync(join(path, OWNER_FILE), JSON.stringify(record));
			return { index, path, owner: record, release: () => release(path, record) };
		}
		return null;
	}

	/** Delete the slot only while it still belongs to this owner; a reclaimed slot may be someone else's now. */
	function release(path, record) {
		const current = readOwner(path);
		if (current !== null && current.pid === record.pid && current.acquiredAt === record.acquiredAt) {
			rmSync(path, { recursive: true, force: true });
		}
	}

	function slotIndexes() {
		return readdirSync(dir)
			.map((name) => SLOT_NAME.exec(name))
			.filter((match) => match !== null)
			.map((match) => Number(match[1]))
			.sort((a, b) => a - b);
	}

	return {
		/** Take the lowest free slot below `capacity`, or null when every one of them is in use. */
		acquire({ capacity, owner }) {
			for (let index = 0; index < capacity; index++) {
				const slot = tryTake(index, owner);
				if (slot !== null) return slot;
			}
			return null;
		},
		/** Reclaim every slot whose owner is gone (reporting each through `onReap`). */
		reapStale() {
			for (const index of slotIndexes()) {
				const path = slotPath(index);
				if (isStale(path)) reclaim(path);
			}
		},
		/** The slots currently on disk with their owners (null while a slot is being created). */
		holders() {
			return slotIndexes().map((index) => ({ index, owner: readOwner(slotPath(index)) }));
		},
	};
}
