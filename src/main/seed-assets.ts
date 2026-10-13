import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { cp, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { isJsonObject } from "../shared/settings-contract";

/**
 * First-launch seeding of the local embedding model and llama.cpp runtime.
 *
 * The installer carries both under `<resources>/seed` (see
 * `scripts/release/stage-tools.mjs`). The librarian looks for them in
 * `<AutoRAG home>/models` and `<AutoRAG home>/runtime`, verified by SHA-256
 * and otherwise downloaded; copying the shipped files into place makes a fresh
 * install work offline and skips a ~650 MB download.
 *
 * The model and the Windows runtime ship as the pinned files themselves. The
 * macOS runtime ships already extracted (a "tree" entry): the notarized app
 * signs every binary in it with the app's Developer ID, so it can no longer
 * match the pinned archive. The tree carries the librarian's
 * `.autorag-archive-sha256` marker, and the librarian accepts it in place of
 * the archive; the app's code signature, not a digest, is what vouches for it.
 */

export interface SeedFile {
	readonly kind: "file";
	/** Path of the shipped file relative to the seed directory. */
	readonly path: string;
	/** Where it goes, relative to the AutoRAG home. */
	readonly destination: string;
	readonly sha256: string;
	readonly bytes: number;
}

/** A shipped directory, copied as a whole (symlinks kept as symlinks). */
export interface SeedTree {
	readonly kind: "tree";
	readonly path: string;
	readonly destination: string;
}

export type SeedEntry = SeedFile | SeedTree;

export interface SeedManifest {
	readonly schema: 1;
	readonly files: readonly SeedEntry[];
}

export type SeedOutcome =
	| { readonly kind: "none" }
	| { readonly kind: "done"; readonly copied: readonly string[]; readonly present: readonly string[] };

export function readSeedManifest(seedDir: string): SeedManifest | null {
	const manifestPath = join(seedDir, "manifest.json");
	if (!existsSync(manifestPath)) return null;
	const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (!isJsonObject(parsed) || parsed.schema !== 1 || !Array.isArray(parsed.files)) throw new Error(`Unsupported seed manifest ${manifestPath}`);
	const files: SeedEntry[] = parsed.files.map((entry: unknown) => {
		const tree = isJsonObject(entry) && entry.kind === "tree";
		if (
			!isJsonObject(entry) ||
			typeof entry.path !== "string" ||
			typeof entry.destination !== "string" ||
			(!tree && (typeof entry.bytes !== "number" || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)))
		) {
			throw new Error(`Seed manifest ${manifestPath} has a malformed entry`);
		}
		// An entry must stay inside its directory: no absolute paths, no `..`.
		for (const path of [entry.path, entry.destination]) {
			const normalized = normalize(path);
			if (isAbsolute(normalized) || normalized === ".." || normalized.startsWith(`..${sep}`)) throw new Error(`Seed path escapes its directory: ${path}`);
		}
		if (tree) return { kind: "tree", path: entry.path, destination: entry.destination };
		return { kind: "file", path: entry.path, destination: entry.destination, sha256: entry.sha256 as string, bytes: entry.bytes as number };
	});
	return { schema: 1, files };
}

/**
 * Copy every manifest entry that is not already in the AutoRAG home. An entry
 * that is there is left alone whatever its content: the librarian verifies it
 * on use and re-downloads a corrupt one, and a user may have swapped in
 * another model on purpose. A file is hashed while it is written; a file or a
 * tree is only renamed into place once complete (and, for a file, matching its
 * SHA-256), so an interrupted or corrupt copy never leaves a half entry where
 * the librarian would trust it.
 */
export async function seedAssets(input: { readonly seedDir: string; readonly autoragHome: string }): Promise<SeedOutcome> {
	const manifest = readSeedManifest(input.seedDir);
	if (manifest === null) return { kind: "none" };
	const copied: string[] = [];
	const present: string[] = [];
	for (const file of manifest.files) {
		const destination = join(input.autoragHome, file.destination);
		if (await stat(destination).then(() => true, () => false)) {
			present.push(file.destination);
			continue;
		}
		if (file.kind === "tree") await copyTree(join(input.seedDir, file.path), destination);
		else await copyVerified(join(input.seedDir, file.path), destination, file);
		copied.push(file.destination);
	}
	return { kind: "done", copied, present };
}

async function copyTree(source: string, destination: string): Promise<void> {
	await mkdir(dirname(destination), { recursive: true });
	const part = `${destination}.seed-part`;
	await rm(part, { recursive: true, force: true });
	try {
		// The runtime's dylibs are versioned symlinks (libggml.dylib -> libggml.0.23.0.dylib).
		await cp(source, part, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
		await rename(part, destination);
	} catch (error) {
		await rm(part, { recursive: true, force: true });
		throw error;
	}
}

async function copyVerified(source: string, destination: string, file: SeedFile): Promise<void> {
	await mkdir(dirname(destination), { recursive: true });
	const part = `${destination}.seed-part`;
	const hash = createHash("sha256");
	const tap = new Transform({
		transform(chunk: Buffer, _encoding, done) {
			hash.update(chunk);
			done(null, chunk);
		},
	});
	try {
		await pipeline(createReadStream(source), tap, createWriteStream(part));
		const actual = hash.digest("hex");
		if (actual !== file.sha256) throw new Error(`Seed file ${file.path} is corrupt: sha256 ${actual}, expected ${file.sha256}`);
		await rename(part, destination);
	} catch (error) {
		await rm(part, { force: true });
		throw error;
	}
}
