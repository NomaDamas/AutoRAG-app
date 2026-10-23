import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createAutomationsStore,
	ruleMenuEntries,
	stepRuleSelection,
	type AutomationsStore,
} from "../src/renderer/src/state/automations-store";
import type {
	AutomationBridge,
	AutomationRemoval,
	AutomationRule,
	AutomationsSnapshot,
} from "../src/shared/automation-contract";
import { IDLE_AUTOMATIONS } from "../src/shared/automation-contract";
import { setAppLanguage } from "../src/shared/i18n/core";

function rule(id: string, overrides: Partial<AutomationRule> = {}): AutomationRule {
	return {
		id,
		paths: ["/Users/jeffrey/Downloads"],
		events: ["create"],
		include: ["**/*.pdf"],
		exclude: [],
		run: ["autorag", "refresh"],
		appendFiles: false,
		debounceMs: 1000,
		timeoutMs: 600_000,
		lastRun: null,
		...overrides,
	};
}

function snapshot(rules: readonly AutomationRule[], overrides: Partial<AutomationsSnapshot> = {}): AutomationsSnapshot {
	return {
		ready: true,
		rules,
		daemon: { platform: "darwin", installed: true, running: true },
		configPath: "/Users/jeffrey/.autorag/automations.json",
		configError: null,
		error: null,
		...overrides,
	};
}

afterEach(async () => {
	await setAppLanguage("ko");
});

describe("stepRuleSelection", () => {
	const rules = [rule("a"), rule("b"), rule("c")];

	it("steps down and up and stops at both ends instead of wrapping", () => {
		expect(stepRuleSelection(rules, "a", 1)).toBe("b");
		expect(stepRuleSelection(rules, "b", -1)).toBe("a");
		expect(stepRuleSelection(rules, "c", 1)).toBe("c");
		expect(stepRuleSelection(rules, "a", -1)).toBe("a");
	});

	it("starts at the first rule going down and the last going up when nothing is selected", () => {
		expect(stepRuleSelection(rules, null, 1)).toBe("a");
		expect(stepRuleSelection(rules, null, -1)).toBe("c");
		expect(stepRuleSelection(rules, "gone", 1)).toBe("a");
	});

	it("selects nothing in an empty list", () => {
		expect(stepRuleSelection([], null, 1)).toBeNull();
	});
});

describe("ruleMenuEntries", () => {
	const labels = (entries: ReturnType<typeof ruleMenuEntries>): string[] =>
		entries.flatMap((entry) => (entry.kind === "item" ? [`${entry.action}:${entry.label}`] : ["-"]));

	it("offers Quick Look, edit, add, and a danger delete on a rule", () => {
		const entries = ruleMenuEntries({ rule: rule("a"), canOpenFolder: false });
		expect(labels(entries)).toEqual(["quickLook:훑어보기", "-", "editRule:AI 검색에서 편집", "addRule:AI 검색에서 새 규칙 추가…", "-", "deleteRule:삭제"]);
		const remove = entries.find((entry) => entry.kind === "item" && entry.action === "deleteRule");
		expect(remove).toMatchObject({ tone: "danger" });
	});

	it("offers to open the watched folder only when asked", () => {
		const entries = ruleMenuEntries({ rule: rule("a"), canOpenFolder: true });
		expect(labels(entries)).toContain("openRuleFolder:감시 폴더 열기");
	});

	it("offers to show the rule in the list only from a folder's rule row, where the list is not already in view", () => {
		const fromFolder = ruleMenuEntries({ rule: rule("a"), canOpenFolder: false, canReveal: true });
		expect(labels(fromFolder)).toContain("revealRule:자동화 탭에서 보기");
		expect(labels(ruleMenuEntries({ rule: rule("a"), canOpenFolder: false }))).not.toContain("revealRule:자동화 탭에서 보기");
	});

	it("offers only add on the empty list background", () => {
		expect(labels(ruleMenuEntries({ rule: null, canOpenFolder: false }))).toEqual(["addRule:AI 검색에서 새 규칙 추가…"]);
	});

	it("is written in the interface language", async () => {
		await setAppLanguage("en");
		expect(labels(ruleMenuEntries({ rule: rule("a"), canOpenFolder: false }))).toEqual([
			"quickLook:Quick Look",
			"-",
			"editRule:Edit in AI Search",
			"addRule:Add a rule in AI Search…",
			"-",
			"deleteRule:Delete",
		]);
	});
});

describe("the automations store", () => {
	let bridge: AutomationBridge & { emit(next: AutomationsSnapshot): void };
	let store: AutomationsStore;

	function makeBridge(initial: AutomationsSnapshot): typeof bridge {
		let listener: ((next: AutomationsSnapshot) => void) | null = null;
		let current = initial;
		const removal: AutomationRemoval = { entry: { id: "a" }, index: 0 };
		return {
			get: vi.fn(async () => current),
			remove: vi.fn(async (id: string) => {
				current = snapshot(current.rules.filter((item) => item.id !== id));
				return { snapshot: current, removal };
			}),
			restore: vi.fn(async () => {
				current = snapshot([rule("a"), rule("b")]);
				return current;
			}),
			setDaemon: vi.fn(async (enabled: boolean) => {
				current = { ...current, daemon: { platform: "darwin", installed: enabled, running: enabled } };
				return current;
			}),
			onChange: vi.fn((next) => {
				listener = next;
				return () => {
					listener = null;
				};
			}),
			emit: (next) => {
				current = next;
				listener?.(next);
			},
		};
	}

	beforeEach(() => {
		bridge = makeBridge(snapshot([rule("a"), rule("b")]));
		store = createAutomationsStore(bridge);
	});

	afterEach(() => {
		store.dispose();
	});

	it("starts idle, loads once on first subscription, and shares the read", async () => {
		expect(store.getSnapshot().state).toBe(IDLE_AUTOMATIONS);
		const unsubscribe = store.subscribe(() => {});
		store.subscribe(() => {});
		await vi.waitFor(() => expect(store.getSnapshot().state.ready).toBe(true));
		expect(bridge.get).toHaveBeenCalledTimes(1);
		expect(store.getSnapshot().state.rules.map((item) => item.id)).toEqual(["a", "b"]);
		unsubscribe();
	});

	it("follows what the main process pushes, whoever changed the rules", async () => {
		const seen = vi.fn();
		store.subscribe(seen);
		await vi.waitFor(() => expect(store.getSnapshot().state.ready).toBe(true));
		bridge.emit(snapshot([rule("a"), rule("b"), rule("c")]));
		expect(store.getSnapshot().state.rules.map((item) => item.id)).toEqual(["a", "b", "c"]);
		expect(seen).toHaveBeenCalled();
	});

	it("stops listening to the main process when the last view goes away", async () => {
		const unsubscribe = store.subscribe(() => {});
		await vi.waitFor(() => expect(store.getSnapshot().state.ready).toBe(true));
		unsubscribe();
		bridge.emit(snapshot([rule("z")]));
		expect(store.getSnapshot().state.rules.map((item) => item.id)).toEqual(["a", "b"]);
	});

	it("deletes a rule, remembers it for undo, and puts it back where it was", async () => {
		store.subscribe(() => {});
		await vi.waitFor(() => expect(store.getSnapshot().state.ready).toBe(true));
		await store.remove("a");
		expect(store.getSnapshot().state.rules.map((item) => item.id)).toEqual(["b"]);
		expect(store.getSnapshot().undo?.rule.id).toBe("a");
		await store.undo();
		expect(bridge.restore).toHaveBeenCalledWith({ entry: { id: "a" }, index: 0 });
		expect(store.getSnapshot().state.rules.map((item) => item.id)).toEqual(["a", "b"]);
		expect(store.getSnapshot().undo).toBeNull();
	});

	it("only keeps the latest deletion to undo", async () => {
		store.subscribe(() => {});
		await vi.waitFor(() => expect(store.getSnapshot().state.ready).toBe(true));
		await store.remove("a");
		await store.remove("b");
		expect(store.getSnapshot().undo?.rule.id).toBe("b");
		store.clearUndo();
		expect(store.getSnapshot().undo).toBeNull();
		await store.undo();
		expect(bridge.restore).not.toHaveBeenCalled();
	});

	it("reports a failed delete without losing the list or the undo of an earlier delete", async () => {
		store.subscribe(() => {});
		await vi.waitFor(() => expect(store.getSnapshot().state.ready).toBe(true));
		await store.remove("a");
		vi.mocked(bridge.remove).mockRejectedValueOnce(new Error("Error invoking remote method 'automations:remove': Error: ‘b’ 규칙을 찾을 수 없습니다."));
		await expect(store.remove("b")).rejects.toThrow("‘b’ 규칙을 찾을 수 없습니다.");
		expect(store.getSnapshot().state.rules.map((item) => item.id)).toEqual(["b"]);
		expect(store.getSnapshot().undo?.rule.id).toBe("a");
	});

	it("turns the background service on and off and shows it busy meanwhile", async () => {
		store.subscribe(() => {});
		await vi.waitFor(() => expect(store.getSnapshot().state.ready).toBe(true));
		const pending = store.setDaemon(false);
		expect(store.getSnapshot().daemonBusy).toBe(true);
		await pending;
		expect(store.getSnapshot().daemonBusy).toBe(false);
		expect(store.getSnapshot().state.daemon).toMatchObject({ installed: false, running: false });
		expect(bridge.setDaemon).toHaveBeenCalledWith(false);
	});

	it("clears busy and rethrows a readable message when the service cannot be changed", async () => {
		store.subscribe(() => {});
		await vi.waitFor(() => expect(store.getSnapshot().state.ready).toBe(true));
		vi.mocked(bridge.setDaemon).mockRejectedValueOnce(new Error("Error invoking remote method 'automations:setDaemon': Error: 자동화 상태를 확인하지 못했습니다: launchctl failed"));
		await expect(store.setDaemon(true)).rejects.toThrow("자동화 상태를 확인하지 못했습니다: launchctl failed");
		expect(store.getSnapshot().daemonBusy).toBe(false);
	});

	it("keeps the last good list when the main process says the read failed", async () => {
		store.subscribe(() => {});
		await vi.waitFor(() => expect(store.getSnapshot().state.ready).toBe(true));
		bridge.emit(snapshot([rule("a"), rule("b")], { error: "boom" }));
		expect(store.getSnapshot().state.error).toBe("boom");
		expect(store.getSnapshot().state.rules).toHaveLength(2);
	});

	it("stays idle but not stuck when the bridge is missing (browser-only dev run)", () => {
		const bare = createAutomationsStore(undefined);
		bare.subscribe(() => {});
		expect(bare.getSnapshot().state).toBe(IDLE_AUTOMATIONS);
		bare.dispose();
	});
});
