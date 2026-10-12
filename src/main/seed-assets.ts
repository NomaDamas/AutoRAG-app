import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
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
 * install work offline and skips a ~650 MB download. The runtime archive is
 * left as an archive: the librarian unpacks it itself on first use.
 */

export interface SeedFile {
	/** Path of the shipped file relative to the seed directory. */
	readonly path: string;
	/** Where it goes, relative to the AutoRAG home. */
	readonly destination: string;
	readonly sha256: string;
	readonly bytes: number;
}

export interface SeedManifest {
	readonly schema: 1;
	readonly files: readonly SeedFile[];
}

export type SeedOutcome =
	| { readonly kind: "none" }
	| { readonly kind: "done"; readonly copied: readonly string[]; readonly present: readonly string[] };

export function readSeedManifest(seedDir: string): SeedManifest | null {
	const manifestPath = join(seedDir, "manifest.json");
	if (!existsSync(manifestPath)) return null;
	const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (!isJsonObject(parsed) || parsed.schema !== 1 || !Array.isArray(parsed.files)) throw new Error(`Unsupported seed manifest ${manifestPath}`);
	const files: SeedFile[] = parsed.files.map((entry: unknown) => {
		if (!isJsonObject(entry) || typeof entry.path !== "string" || typeof entry.destination !== "string" || typeof entry.bytes !== "number" || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
			throw new Error(`Seed manifest ${manifestPath} has a malformed entry`);
		}
		// An entry must stay inside its directory: no absolute paths, no `..`.
		for (const path of [entry.path, entry.destination]) {
			const normalized = normalize(path);
			if (isAbsolute(normalized) || normalized === ".." || normalized.startsWith(`..${sep}`)) throw new Error(`Seed path escapes its directory: ${path}`);
		}
		return { path: entry.path, destination: entry.destination, sha256: entry.sha256, bytes: entry.bytes };
	});
	return { schema: 1, files };
}

/**
 * Copy every manifest file that is not already in the AutoRAG home. A file
 * that is there is left alone whatever its content: the librarian verifies it
 * on use and re-downloads a corrupt one, and a user may have swapped in
 * another model on purpose. Each copy is hashed while it is written and only
 * renamed into place when the SHA-256 matches, so an interrupted or corrupt
 * copy never leaves a half file where the librarian would trust it.
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
		await copyVerified(join(input.seedDir, file.path), destination, file);
		copied.push(file.destination);
	}
	return { kind: "done", copied, present };
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
