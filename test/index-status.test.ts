import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { minSyncDocumentPath, minSyncWorkspaceRoot, saveMirrorIndex } from "@autorag/librarian";
import { afterEach, describe, expect, it } from "vitest";
import { createIndexStatusService } from "../src/main/index-status";

const directories: string[] = [];

afterEach(async () => {
	const pending = directories.splice(0);
	// Windows cannot unlink the just-refreshed `.autorag` tree while the
	// in-process librarian still holds its handles (verified: every recursive
	// `rm` retry budget up to ~18s fails). %TEMP% is reclaimed by the OS, so skip
	// the doomed removal there rather than hanging the hook; POSIX removes it.
	if (process.platform === "win32") {
		console.warn("[index-status.test] leaving %TEMP% fixtures for the OS to reclaim (Windows holds .autorag handles)");
		return;
	}
	await Promise.all(pending.map((directory) => rm(directory, { recursive: true, force: true })));
});

interface Fixture {
	readonly docs: string;
	readonly workspace: string;
	readonly configPath: string;
	readonly env: NodeJS.ProcessEnv;
}

/** A real config + parsed mirror + MinSync staging tree, the layout a refresh leaves behind. */
async function createFixture(): Promise<Fixture> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "autorag-index-status-")));
	directories.push(root);
	const docs = join(root, "docs");
	const workspace = join(root, "workspace");
	await mkdir(join(docs, "private"), { recursive: true });
	await mkdir(workspace, { recursive: true });
	const configPath = join(root, "config.json");
	await writeFile(configPath, `${JSON.stringify({ searchPaths: [docs], workspacePath: workspace, minSync: { enabled: true } }, null, 2)}\n`);
	return { docs, workspace, configPath, env: { HOME: root, AUTORAG_CONFIG: configPath } };
}

async function indexFile(fixture: Fixture, name: string, staged: boolean): Promise<string> {
	const sourcePath = join(fixture.docs, name);
	await writeFile(sourcePath, `${name}\n`);
	const virtualPath = `/docs/${name}`;
	const outputPath = join(fixture.workspace, ".autorag", "parsed", "files", `${name}.md`);
	await mkdir(join(fixture.workspace, ".autorag", "parsed", "files"), { recursive: true });
	await writeFile(outputPath, `${name}\n`);
	saveMirrorIndex(fixture.workspace, {
		version: 1,
		entries: {
			[virtualPath]: {
				virtualPath,
				sourcePath,
				outputPath,
				parserName: "plain-text",
				sourceMtimeNs: 1,
				sourceSizeBytes: 1,
				updatedAt: new Date(0).toISOString(),
			},
		},
	});
	if (staged) {
		const stagedPath = minSyncDocumentPath(minSyncWorkspaceRoot(fixture.workspace), virtualPath);
		await mkdir(join(stagedPath, ".."), { recursive: true });
		await writeFile(stagedPath, `${name}\n`);
	}
	return sourcePath;
}

describe("createIndexStatusService", () => {
	it("reports included only when the file is both parsed and staged into MinSync", async () => {
		const fixture = await createFixture();
		const staged = await indexFile(fixture, "staged.txt", true);
		const service = createIndexStatusService({ env: fixture.env, cwd: fixture.workspace, onRefreshed: () => {} });

		const [status] = await service.indexStatus([staged]);
		expect(status).toMatchObject({ kind: "included", excluded: false, toggleable: true });

		const parsedOnly = await indexFile(fixture, "parsed-only.txt", false);
		const [pending] = await service.indexStatus([parsedOnly]);
		expect(pending?.kind).toBe("pending");
	});

	it("reports files outside every search path as outside and not toggleable", async () => {
		const fixture = await createFixture();
		const service = createIndexStatusService({ env: fixture.env, cwd: fixture.workspace, onRefreshed: () => {} });

		const [status] = await service.indexStatus([join(fixture.workspace, "elsewhere.txt")]);
		expect(status).toMatchObject({ kind: "outside", toggleable: false });
	});

	it("persists an exclusion to the shared config and reports it pending while the file is still indexed", async () => {
		const fixture = await createFixture();
		const staged = await indexFile(fixture, "staged.txt", true);
		const service = createIndexStatusService({ env: fixture.env, cwd: fixture.workspace, onRefreshed: () => {} });

		const status = await service.setIndexExcluded(staged, true);
		const config = JSON.parse(await readFile(fixture.configPath, "utf8")) as { excludePaths?: string[] };

		expect(config.excludePaths).toEqual([staged]);
		expect(status).toMatchObject({ kind: "pending", excluded: true, toggleable: true });

		await service.setIndexExcluded(staged, false);
		const cleared = JSON.parse(await readFile(fixture.configPath, "utf8")) as { excludePaths?: string[] };
		expect(cleared.excludePaths).toBeUndefined();
	});

	it("marks files under an excluded folder excluded but leaves the toggle to the folder", async () => {
		const fixture = await createFixture();
		const folder = join(fixture.docs, "private");
		await writeFile(fixture.configPath, `${JSON.stringify({ searchPaths: [fixture.docs], workspacePath: fixture.workspace, excludePaths: [folder] }, null, 2)}\n`);
		const service = createIndexStatusService({ env: fixture.env, cwd: fixture.workspace, onRefreshed: () => {} });

		const [status] = await service.indexStatus([join(folder, "secret.txt")]);
		expect(status).toMatchObject({ kind: "excluded", excluded: true, toggleable: false });
	});
});
