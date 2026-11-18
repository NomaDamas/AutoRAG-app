import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import type * as NodeFs from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { ArchiveReader, libarchiveWasm } from "libarchive-wasm";
import { describe, expect, it } from "vitest";
import { createActionService } from "../src/main/action-service";

/**
 * Electron patches `node:fs` so a path through a `*.asar` file reads inside that
 * archive: reading the file itself fails with "ENOENT, not found in …asar". Any
 * folder holding an Electron app (every `node_modules/electron`) has one, so the
 * archivers must read through the unpatched fs. The patch exists only in
 * Electron's runtime, so under plain Node this file re-runs itself there.
 */
const inElectron = process.versions.electron !== undefined;

function makeService() {
	return createActionService({
		platform: "darwin",
		applications: { pick: async () => null },
		applicationIcon: async () => "",
		share: { present: () => undefined },
		trash: async (target) => {
			await rm(target, { force: true });
		},
		run: async () => ({ stdout: "", stderr: "" }),
	});
}

describe("compressing a folder that holds an .asar file", () => {
	it.runIf(inElectron)("writes the .asar file's own bytes into zip and 7z", async () => {
		// `original-fs` exists only in Electron, so it is required at run time rather than imported.
		const rawFs = createRequire(import.meta.url)("original-fs") as typeof NodeFs;
		const root = await mkdtemp(join(tmpdir(), "autorag-asar-"));
		try {
			const source = join(root, "app");
			await mkdir(join(source, "Resources"), { recursive: true });
			// Not a valid asar: Electron's fs would still try to open it as one.
			const body = Buffer.from("plain bytes in a file named like an Electron archive");
			rawFs.writeFileSync(join(source, "Resources", "default_app.asar"), body);
			const service = makeService();

			const zip = await service.run([source], { kind: "compress", format: "zip" }, null);
			const zipped = unzipSync(new Uint8Array(await readFile(zip.output ?? "")));
			expect(Buffer.from(zipped["app/Resources/default_app.asar"] ?? [])).toEqual(body);

			const sevenZip = await service.run([source], { kind: "compress", format: "7z" }, null);
			const archive = await readFile(sevenZip.output ?? "");
			const reader = new ArchiveReader(
				await libarchiveWasm({ wasmBinary: await readFile(new URL("../src/main/vendor/libarchive.wasm", import.meta.url)) }),
				new Int8Array(archive.buffer, archive.byteOffset, archive.byteLength),
			);
			const contents = new Map<string, Buffer>();
			for (const entry of reader.entries()) contents.set(entry.getPathname(), Buffer.from(entry.readData() ?? new Uint8Array(0)));
			reader.free();
			expect(contents.get("app/Resources/default_app.asar")).toEqual(body);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(inElectron)("passes under Electron's runtime", { timeout: 120_000 }, () => {
		const require = createRequire(import.meta.url);
		const electron = require("electron") as unknown as string;
		const vitest = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
		const result = spawnSync(electron, [vitest, "run", fileURLToPath(import.meta.url)], {
			cwd: fileURLToPath(new URL("..", import.meta.url)),
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
			encoding: "utf8",
		});
		const output = `${result.stdout}\n${result.stderr}`;
		expect(output, output).toMatch(/Tests\s+1 passed/);
		expect(result.status, output).toBe(0);
	});
});
