import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createAutomationVerificationTracker,
	createTestAutomationInSandboxTool,
	TEST_AUTOMATION_IN_SANDBOX_TOOL_NAME,
	testAutomationInSandbox,
} from "../src/main/automation-sandbox";
import { resolveNodeBinary, runAutomationToolOnNode } from "../src/main/automation-runtime";
import { sampleFilenameForGlob } from "../src/main/sandbox-fixtures";

const cleanups: Array<() => Promise<void> | void> = [];
let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "dazzi-automation-sandbox-test-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("automation sandbox verification", () => {
	it("generates concrete filenames that match common include globs", () => {
		expect(sampleFilenameForGlob("**/IMG_*.jpg")).toBe("IMG_0001.jpg");
		expect(sampleFilenameForGlob("**/*.pdf")).toBe("sample.pdf");
		expect(sampleFilenameForGlob("docs/*.md")).toBe("docs/sample.md");
		expect(sampleFilenameForGlob("*.{png,jpg}")).toBe("sample.png");
		expect(sampleFilenameForGlob("report-??.txt")).toBe("report-12.txt");
		expect(sampleFilenameForGlob("**/*")).toBe("sample.txt");
	});

	it.skipIf(process.platform === "win32")(
		"runs a real command automation rule in an isolated temp folder, reports created files, and leaves real AUTORAG_HOME untouched",
		async () => {
			const realHome = join(root, "real-autorag-home");
			await mkdir(realHome, { recursive: true });
			const realRulesPath = join(realHome, "automations.json");
			const originalRules = `${JSON.stringify({ automations: [{ id: "existing", paths: [root], events: ["create"], include: ["**/*"], run: ["echo", "keep"] }] }, null, 2)}\n`;
			await writeFile(realRulesPath, originalRules, "utf8");

			const nodeBin = resolveNodeBinary({
				resourcesPath: "",
				env: process.env,
				platform: process.platform,
			});
			expect(nodeBin).toBeDefined();

			const result = await testAutomationInSandbox(
				{
					rule: {
						id: "txt-to-upper",
						events: ["create"],
						include: ["**/*.txt"],
						run: [
							"sh",
							"-c",
							'for f in "$@"; do tr "a-z" "A-Z" < "$f" > "${f%.txt}.upper.log"; done; echo "processed:$#"',
							"sh",
						],
						appendFiles: true,
					},
					fixtures: [{ path: "memo.txt", content: "hello automation\n" }],
					events: [{ type: "create", path: "memo.txt" }],
				},
				{
					env: { ...process.env, AUTORAG_HOME: realHome },
					findNode: () => nodeBin,
				},
			);

			expect(result.ok).toBe(true);
			expect(result.exitCode).toBe(0);
			expect(result.timedOut).toBe(false);
			expect(result.stdout).toContain("processed:1");
			expect(result.matchedEvents).toEqual([{ type: "create", path: "memo.txt" }]);
			expect(result.diff.created.map((f) => f.path)).toEqual(["memo.upper.log"]);
			expect(result.diff.created[0]?.contentPreview).toBe("HELLO AUTOMATION\n");
			expect(result.retriggerWarnings).toEqual([]);

			// Real AUTORAG_HOME was never modified
			expect(await readFile(realRulesPath, "utf8")).toBe(originalRules);
			expect(existsSync(join(realHome, "automations", "logs", "txt-to-upper.jsonl"))).toBe(false);
		},
	);

	it.skipIf(process.platform === "win32")(
		"seeds a valid JPEG fixture matching **/IMG_*.jpg and rewrites literal originalPaths into the temp folder",
		async () => {
			const realWatched = join(root, "real-downloads");
			await mkdir(realWatched, { recursive: true });
			const nodeBin = resolveNodeBinary({
				resourcesPath: "",
				env: process.env,
				platform: process.platform,
			});

			const result = await testAutomationInSandbox(
				{
					rule: {
						id: "photo-header-check",
						events: ["create"],
						include: ["**/IMG_*.jpg"],
						run: [
							"node",
							"-e",
							`const fs = require("node:fs"); const files = fs.readdirSync(${JSON.stringify(realWatched)}); const bytes = fs.readFileSync(process.argv[1]); console.log("files=" + files.join(",") + " magic=" + bytes.subarray(0,3).toString("hex"));`,
						],
						appendFiles: true,
					},
					originalPaths: [realWatched],
				},
				{
					env: process.env,
					findNode: () => nodeBin,
				},
			);

			expect(result.ok).toBe(true);
			expect(result.stdout).toContain("files=IMG_0001.jpg");
			expect(result.stdout).toContain("magic=ffd8ff");
			// Real watched folder stayed completely empty
			expect(existsSync(join(realWatched, "IMG_0001.jpg"))).toBe(false);
		},
	);

	it.skipIf(process.platform === "win32")(
		"detects self-retrigger infinite loop risk when a rule creates a file matching its own include glob, and clears it when excluded",
		async () => {
			const nodeBin = resolveNodeBinary({
				resourcesPath: "",
				env: process.env,
				platform: process.platform,
			});

			const looping = await testAutomationInSandbox(
				{
					rule: {
						id: "md-summary-loop",
						events: ["create"],
						include: ["**/*.md"],
						run: ["sh", "-c", 'echo "# Summary" > "$(dirname "$1")/summary.md"', "sh"],
						appendFiles: true,
					},
					fixtures: [{ path: "meeting.md", content: "# Meeting\n" }],
				},
				{
					env: process.env,
					findNode: () => nodeBin,
				},
			);
			expect(looping.ok).toBe(true);
			expect(looping.retriggerWarnings.length).toBeGreaterThan(0);
			expect(looping.retriggerWarnings[0]).toContain("summary.md");

			const safe = await testAutomationInSandbox(
				{
					rule: {
						id: "md-summary-safe",
						events: ["create"],
						include: ["**/*.md"],
						exclude: ["**/*summary*.md"],
						run: ["sh", "-c", 'echo "# Summary" > "$(dirname "$1")/summary.md"', "sh"],
						appendFiles: true,
					},
					fixtures: [{ path: "meeting.md", content: "# Meeting\n" }],
				},
				{
					env: process.env,
					findNode: () => nodeBin,
				},
			);
			expect(safe.ok).toBe(true);
			expect(safe.retriggerWarnings).toEqual([]);
		},
	);

	it.skipIf(process.platform === "win32")(
		"reports failure when the automation command exits non-zero so the agent can fix and retry",
		async () => {
			const nodeBin = resolveNodeBinary({
				resourcesPath: "",
				env: process.env,
				platform: process.platform,
			});
			const result = await testAutomationInSandbox(
				{
					rule: {
						id: "broken-rule",
						events: ["create"],
						include: ["**/*.md"],
						run: ["sh", "-c", 'echo "bad script syntax" >&2; exit 3'],
					},
					fixtures: [{ path: "doc.md", content: "# hi\n" }],
				},
				{
					env: process.env,
					findNode: () => nodeBin,
				},
			);

			expect(result.ok).toBe(false);
			expect(result.exitCode).toBe(3);
			expect(result.stderr).toContain("bad script syntax");
			expect(result.error).toContain("bad script syntax");
		},
	);

	it.skipIf(process.platform === "win32")(
		"reports failure when include globs do not match the test event",
		async () => {
			const nodeBin = resolveNodeBinary({
				resourcesPath: "",
				env: process.env,
				platform: process.platform,
			});
			const result = await testAutomationInSandbox(
				{
					rule: {
						id: "pdf-only",
						events: ["create"],
						include: ["**/*.pdf"],
						run: ["sh", "-c", "echo ran"],
					},
					fixtures: [{ path: "note.txt", content: "not a pdf\n" }],
					events: [{ type: "create", path: "note.txt" }],
				},
				{
					env: process.env,
					findNode: () => nodeBin,
				},
			);

			expect(result.ok).toBe(false);
			expect(result.error).toMatch(/matched/i);
		},
	);

	it.skipIf(process.platform === "win32")(
		"enforces temporary-sandbox verification on manage_automations save: blocks broken rules and saves verified rules",
		async () => {
			const nodeBin = resolveNodeBinary({
				resourcesPath: "",
				env: process.env,
				platform: process.platform,
			});
			const tracker = createAutomationVerificationTracker();
			const sandboxDeps = { env: process.env, findNode: () => nodeBin };
			const testTool = createTestAutomationInSandboxTool({ ...sandboxDeps, tracker });

			const underlyingSave = vi.fn(
				async (_id: string, params: { readonly action: string; readonly id?: string; readonly automation?: Record<string, unknown> }) => ({
					content: [{ type: "text", text: `Saved ${params.action}` }],
					details: { action: params.action },
				}),
			);
			const fakeManageTool = {
				name: "manage_automations",
				description: "Manage automations.",
				execute: underlyingSave,
			};
			runAutomationToolOnNode({ tools: [fakeManageTool] }, () => nodeBin, {
				tracker,
				verifyRule: (rule, originalPaths) => testAutomationInSandbox({ rule, originalPaths }, sandboxDeps),
			});

			expect(fakeManageTool.description).toContain(TEST_AUTOMATION_IN_SANDBOX_TOOL_NAME);

			// 1. Attempt to save a broken rule directly without testing -> BLOCKED by automatic temp-folder sandbox check
			const brokenSave = (await fakeManageTool.execute("c1", {
				action: "save",
				id: "broken-md",
				automation: {
					paths: [root],
					events: ["create"],
					include: ["**/*.md"],
					run: ["sh", "-c", 'echo "broken cmd" >&2; exit 4'],
				},
			})) as { content: { type: string; text: string }[]; details: { saved?: boolean } };
			expect(underlyingSave).not.toHaveBeenCalled();
			expect(brokenSave.details.saved).toBe(false);
			expect(brokenSave.content[0]?.text).toContain("NOT saved");
			expect(brokenSave.content[0]?.text).toContain("broken cmd");

			// 2. Fix rule, test via test_automation_in_sandbox -> passes and marks rule verified
			const fixedRule = {
				id: "fixed-md",
				events: ["create" as const],
				include: ["**/*.md"],
				run: ["sh", "-c", 'cp "$1" "${1}.bak" && echo "backed-up"', "sh"],
				appendFiles: true,
			};
			const testRes = await testTool.execute("c2", {
				...fixedRule,
				fixtures: [{ path: "a.md", content: "# A\n" }],
			} as never);
			const testPayload = JSON.parse(testRes.content[0]?.type === "text" ? testRes.content[0].text : "{}");
			expect(testPayload.ok).toBe(true);
			expect(testPayload.diff.created.map((f: { path: string }) => f.path)).toEqual(["a.md.bak"]);

			// 3. Save the verified rule -> succeeds immediately
			const okSave = (await fakeManageTool.execute("c3", {
				action: "save",
				id: "fixed-md",
				automation: {
					paths: [root],
					events: fixedRule.events,
					include: fixedRule.include,
					run: fixedRule.run,
					appendFiles: fixedRule.appendFiles,
				},
			})) as { content: { type: string; text: string }[] };
			expect(underlyingSave).toHaveBeenCalledTimes(1);
			expect(okSave.content[0]?.text).toContain("Verified in temporary sandbox");
		},
	);
});
