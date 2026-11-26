import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type AppSettings } from "../src/shared/settings-contract";
import { createMagicActionTools } from "../src/main/magic-action-tools";
import { verifyMagicActionInSandbox, type MagicActionVerificationResult } from "../src/main/magic-action-sandbox";

function makeMemorySettings(initial: AppSettings = DEFAULT_SETTINGS) {
	let current = structuredClone(initial);
	return {
		get: async () => structuredClone(current),
		set: async (patch: Partial<AppSettings>) => {
			current = { ...current, ...patch };
			return structuredClone(current);
		},
		peek: () => current,
	};
}

function getTool(tools: readonly { readonly name: string; readonly execute: (...args: any[]) => Promise<any> }[], name: string) {
	const found = tools.find((tool) => tool.name === name);
	if (found === undefined) throw new Error(`Missing tool ${name}`);
	return found;
}

describe("shared magic-action-tools", () => {
	it("exposes 3 tools for app-customizer (without list) and 4 tools for the main AI agent (with list)", () => {
		const settings = makeMemorySettings();
		const forCustomizer = createMagicActionTools({ settings, includeListTool: false });
		expect(forCustomizer.tools.map((t) => t.name).sort()).toEqual([
			"delete_magic_action",
			"test_magic_action",
			"upsert_magic_action",
		]);

		const forMainAgent = createMagicActionTools({ settings, includeListTool: true });
		expect(forMainAgent.tools.map((t) => t.name).sort()).toEqual([
			"delete_magic_action",
			"list_magic_actions",
			"test_magic_action",
			"upsert_magic_action",
		]);
	});

	it.skipIf(process.platform === "win32")(
		"supports create -> verify fail -> fix -> re-verify pass -> save -> list -> customize -> delete end-to-end",
		async () => {
			const settings = makeMemorySettings();
			const changes: string[] = [];
			const testSpy = vi.fn((input) =>
				verifyMagicActionInSandbox(input, {
					resolveModel: () => Promise.reject(new Error("unused")),
					agentDir: "",
					env: process.env,
					platform: process.platform,
					language: () => "ko",
				}),
			);
			const kit = createMagicActionTools({
				settings,
				includeListTool: true,
				platform: process.platform,
				language: () => "ko",
				testMagicAction: testSpy,
				onChange: (change) => changes.push(change.summary),
			});

			const listTool = getTool(kit.tools, "list_magic_actions");
			const testTool = getTool(kit.tools, "test_magic_action");
			const upsertTool = getTool(kit.tools, "upsert_magic_action");
			const deleteTool = getTool(kit.tools, "delete_magic_action");

			// 1. Initially empty
			const emptyList = JSON.parse((await listTool.execute("c0", {})).content[0].text);
			expect(emptyList.ok).toBe(true);
			expect(emptyList.magicActions).toEqual([]);

			// 2. Trying to save a broken Magic Action directly is blocked by the shared verifyBeforeSave gate
			const blocked = JSON.parse(
				(
					await upsertTool.execute("c1", {
						id: "upper-copy",
						label: "Uppercase Copy",
						selection: "single",
						targetKind: "file",
						extensions: ["txt"],
						executionKind: "script",
						command: 'dazzi_no_such_cmd_abc "$1"',
					})
				).content[0].text,
			);
			expect(blocked.ok).toBe(false);
			expect(blocked.saved).toBe(false);
			expect(blocked.verified).toBe(false);
			expect(settings.peek().contextMenu.magicActions).toHaveLength(0);

			// 3. Test fixed version in sandbox -> succeeds and caches verification
			const tested = JSON.parse(
				(
					await testTool.execute("c2", {
						label: "Uppercase Copy",
						selection: "single",
						targetKind: "file",
						extensions: ["txt"],
						executionKind: "script",
						command: 'tr "[:lower:]" "[:upper:]" < "$1" > "$1.upper.txt" && cat "$1.upper.txt"',
						fixtures: [{ path: "note.txt", content: "hello world\n" }],
					})
				).content[0].text,
			);
			expect(tested.ok).toBe(true);
			expect(tested.output).toBe("HELLO WORLD");
			expect(tested.diff.created.map((f: { path: string }) => f.path)).toEqual(["note.txt.upper.txt"]);

			// 4. Save verified version -> uses cache (no duplicate sandbox run)
			const callsBeforeSave = testSpy.mock.calls.length;
			const saved = JSON.parse(
				(
					await upsertTool.execute("c3", {
						id: "upper-copy",
						label: "Uppercase Copy",
						selection: "single",
						targetKind: "file",
						extensions: ["txt"],
						executionKind: "script",
						command: 'tr "[:lower:]" "[:upper:]" < "$1" > "$1.upper.txt" && cat "$1.upper.txt"',
					})
				).content[0].text,
			);
			expect(saved.ok).toBe(true);
			expect(saved.saved).toBe(true);
			expect(saved.verified).toBe(true);
			expect(saved.autoVerified).toBe(false);
			expect(testSpy.mock.calls.length).toBe(callsBeforeSave);

			// 5. List returns the saved Magic Action
			const listed = JSON.parse((await listTool.execute("c4", {})).content[0].text);
			expect(listed.magicActions).toHaveLength(1);
			expect(listed.magicActions[0].id).toBe("upper-copy");

			// 6. Customizing (updating) the command invalidates cache and automatically verifies the updated command
			const updated = JSON.parse(
				(
					await upsertTool.execute("c5", {
						id: "upper-copy",
						label: "Uppercase Copy v2",
						selection: "single",
						targetKind: "file",
						extensions: ["txt"],
						executionKind: "script",
						command: 'tr "[:lower:]" "[:upper:]" < "$1" > "$1.v2.txt" && echo "V2_OK"',
					})
				).content[0].text,
			);
			expect(updated.ok).toBe(true);
			expect(updated.autoVerified).toBe(true);
			expect((updated.verification as MagicActionVerificationResult).output).toBe("V2_OK");
			expect(settings.peek().contextMenu.magicActions).toHaveLength(1);
			expect(settings.peek().contextMenu.magicActions[0]?.label).toBe("Uppercase Copy v2");

			// 7. Delete removes it
			const deleted = JSON.parse((await deleteTool.execute("c6", { idOrLabel: "upper-copy" })).content[0].text);
			expect(deleted.ok).toBe(true);
			expect(settings.peek().contextMenu.magicActions).toHaveLength(0);
			expect(changes).toHaveLength(3);
		},
	);

	it("runs temp-folder sandbox verification BEFORE confirmSave, skips save on cancel, and saves confirmed edits on approve", async () => {
		const events: string[] = [];
		const settings = makeMemorySettings();
		const origSet = settings.set;
		settings.set = async (patch) => {
			events.push("save");
			return origSet(patch);
		};

		const okResult: MagicActionVerificationResult = {
			ok: true,
			executionKind: "script",
			exitCode: 0,
			timedOut: false,
			durationMs: 12,
			output: "OK",
			stderr: "",
			targetPaths: ["sample.txt"],
			diff: { created: [], modified: [], deleted: [], unchanged: ["sample.txt"] },
		};
		const failResult: MagicActionVerificationResult = {
			...okResult,
			ok: false,
			exitCode: 1,
			error: "broken script",
		};

		let nextVerify: MagicActionVerificationResult = failResult;
		let nextConfirm: ((action: import("../src/shared/context-menu-contract").MagicAction) => import("../src/shared/context-menu-contract").MagicAction | null) = (a) => a;

		const confirmSpy = vi.fn(async (action: import("../src/shared/context-menu-contract").MagicAction) => {
			events.push("confirm");
			return nextConfirm(action);
		});

		const kit = createMagicActionTools({
			settings,
			includeListTool: false,
			platform: "darwin",
			language: () => "en",
			testMagicAction: async () => {
				events.push("verify");
				return nextVerify;
			},
			confirmSave: confirmSpy,
		});
		const upsertTool = kit.tools.find((t) => t.name === "upsert_magic_action")! as unknown as {
			execute: (id: string, params: Record<string, unknown>) => Promise<{ content: [{ type: "text"; text: string }] }>;
		};

		// 1. Failing verification -> confirmSave is NEVER called, nothing saved
		const failed = JSON.parse(
			(
				await upsertTool.execute("u1", {
					id: "broken-act",
					label: "Broken",
					executionKind: "script",
					command: "exit 1",
				})
			).content[0].text,
		);
		expect(failed.ok).toBe(false);
		expect(failed.saved).toBe(false);
		expect(events).toEqual(["verify"]);
		expect(confirmSpy).not.toHaveBeenCalled();
		expect(settings.peek().contextMenu.magicActions).toHaveLength(0);

		// 2. Passing verification + user cancels confirmation -> nothing saved
		events.length = 0;
		nextVerify = okResult;
		nextConfirm = () => null;
		const cancelled = JSON.parse(
			(
				await upsertTool.execute("u2", {
					id: "good-act",
					label: "Good Action",
					executionKind: "script",
					command: 'echo "OK"',
				})
			).content[0].text,
		);
		expect(cancelled.ok).toBe(true);
		expect(cancelled.saved).toBe(false);
		expect(cancelled.cancelledByUser).toBe(true);
		expect(events).toEqual(["verify", "confirm"]);
		expect(settings.peek().contextMenu.magicActions).toHaveLength(0);

		// 3. Passing verification + user approves with edits -> persists confirmed action
		events.length = 0;
		nextConfirm = (action) => ({ ...action, selection: "multiple" });
		const approved = JSON.parse(
			(
				await upsertTool.execute("u3", {
					id: "good-act-2",
					label: "Good Action 2",
					selection: "single",
					executionKind: "script",
					command: 'echo "OK 2"',
				})
			).content[0].text,
		);
		expect(approved.ok).toBe(true);
		expect(approved.saved).toBe(true);
		expect(events).toEqual(["verify", "confirm", "save"]);
		expect(settings.peek().contextMenu.magicActions).toHaveLength(1);
		expect(settings.peek().contextMenu.magicActions[0]?.selection).toBe("multiple");
	});
});
