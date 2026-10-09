import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FolderScan } from "../src/shared/onboarding-contract";
import { scanFolder, type FolderScanOptions } from "../src/main/onboarding-scan";

const directories: string[] = [];
const SUPPORTED = new Set([".txt", ".pdf", ".md"]);

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "autorag-scan-"));
	directories.push(root);
	await writeFile(join(root, "a.txt"), "hello");
	await writeFile(join(root, "b.pdf"), "pdf");
	await writeFile(join(root, "c.bin"), "unsupported");
	await writeFile(join(root, "big.txt"), "x".repeat(50));
	await mkdir(join(root, "sub"));
	await writeFile(join(root, "sub", "d.md"), "md");
	await mkdir(join(root, "node_modules"));
	await writeFile(join(root, "node_modules", "ignored.txt"), "ignored");
	await mkdir(join(root, ".git"));
	await writeFile(join(root, ".git", "ignored.txt"), "ignored");
	return root;
}

async function runScan(root: string, overrides: Partial<FolderScanOptions> = {}): Promise<FolderScan> {
	const seen: FolderScan[] = [];
	const final = await scanFolder(
		root,
		{
			supportedExtensions: SUPPORTED,
			maxSourceBytes: 10,
			...overrides,
		},
		(scan) => seen.push(scan),
		new AbortController().signal,
	);
	return final;
}

describe("scanFolder", () => {
	it("counts supported, size-capped files and skips code/dependency dirs", async () => {
		const root = await fixture();
		const final = await runScan(root);
		// a.txt (5) and b.pdf (3) pass the 10-byte cap; big.txt (50) is capped;
		// c.bin is unsupported; sub/d.md is 2 bytes; node_modules and .git are skipped.
		expect(final.files).toBe(3);
		expect(final.bytes).toBe(10);
		expect(final.done).toBe(true);
		expect(final.error).toBeNull();
	});

	it("honours a caller-supplied skip set and extension set", async () => {
		const root = await fixture();
		const final = await runScan(root, {
			supportedExtensions: new Set([".bin"]),
			maxSourceBytes: 1000,
			skipDirNames: { sub: true as const },
		});
		expect(final.files).toBe(1);
		expect(final.bytes).toBe(11);
	});

	it("counts cloud placeholders as onlineOnly, never as files", async () => {
		const root = await fixture();
		const placeholder = join(root, "a.txt");
		const final = await runScan(root, { datalessPaths: new Set([placeholder]) });
		expect(final.files).toBe(2);
		expect(final.onlineOnly).toBe(1);
	});

	it("streams running totals and stops on abort", async () => {
		const root = await fixture();
		const controller = new AbortController();
		controller.abort();
		const seen: FolderScan[] = [];
		const final = await scanFolder(
			root,
			{ supportedExtensions: SUPPORTED, maxSourceBytes: 10 },
			(scan) => seen.push(scan),
			controller.signal,
		);
		expect(final.done).toBe(true);
		expect(seen.at(-1)).toEqual(final);
	});
});
