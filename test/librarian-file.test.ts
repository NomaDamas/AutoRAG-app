import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLibrarianFile, statLibrarianFile } from "../src/main/librarian-file";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("librarian file reads", () => {
	it("returns the text and the signature of a file that exists", async () => {
		const directory = await mkdtemp(join(tmpdir(), "autorag-librarian-file-"));
		directories.push(directory);
		const path = join(directory, "refresh-progress.json");
		await writeFile(path, '{"state":"running"}\n');

		expect(readLibrarianFile(path)).toBe('{"state":"running"}\n');
		expect(statLibrarianFile(path)).toMatchObject({ size: 20 });
	});

	it("reports a file that is not there as null instead of throwing: a poll before the first write is normal", async () => {
		const directory = await mkdtemp(join(tmpdir(), "autorag-librarian-file-"));
		directories.push(directory);
		const path = join(directory, "missing.json");

		expect(readLibrarianFile(path)).toBeNull();
		expect(statLibrarianFile(path)).toBeNull();
	});
});
