// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutomationsShell, type AutomationsShell, type AutomationsShellDeps } from "../src/renderer/src/hooks/useAutomationsShell";
import { createAutomationsStore, type AutomationsStore } from "../src/renderer/src/state/automations-store";
import { useSyncExternalStore } from "react";
import type { AutomationBridge, AutomationRule, AutomationsSnapshot } from "../src/shared/automation-contract";
import { setAppLanguage } from "../src/shared/i18n";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	act(() => root.unmount());
	host.remove();
	vi.useRealTimers();
	await setAppLanguage("ko");
});

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

function snapshot(rules: readonly AutomationRule[]): AutomationsSnapshot {
	return { ready: true, rules, daemon: { platform: "darwin", installed: true, running: true }, configPath: "/x/automations.json", configError: null, error: null };
}

interface Harness {
	shell(): AutomationsShell;
	store: AutomationsStore;
	deps: { openAiDraft: ReturnType<typeof vi.fn>; openFolder: ReturnType<typeof vi.fn>; showInList: ReturnType<typeof vi.fn>; onError: ReturnType<typeof vi.fn> };
	bridge: AutomationBridge;
}

async function mount(initial: readonly AutomationRule[], options: { active?: boolean; removeFails?: boolean } = {}): Promise<Harness> {
	let current = snapshot(initial);
	let removed: AutomationRule | undefined;
	let removedIndex = 0;
	const bridge: AutomationBridge = {
		get: async () => current,
		remove: async (id) => {
			if (options.removeFails === true) throw new Error("Error invoking remote method 'automations:remove': Error: 규칙을 찾을 수 없습니다.");
			removedIndex = current.rules.findIndex((item) => item.id === id);
			removed = current.rules[removedIndex];
			current = snapshot(current.rules.filter((item) => item.id !== id));
			return { snapshot: current, removal: { entry: { id }, index: removedIndex } };
		},
		restore: async () => {
			const next = [...current.rules];
			if (removed !== undefined) next.splice(removedIndex, 0, removed);
			current = snapshot(next);
			return current;
		},
		setDaemon: async () => current,
		onChange: () => () => {},
	};
	const store = createAutomationsStore(bridge);
	const deps = { openAiDraft: vi.fn(), openFolder: vi.fn(), showInList: vi.fn(), onError: vi.fn() };
	let latest: AutomationsShell | undefined;
	function Probe(): null {
		const view = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
		const shellDeps: AutomationsShellDeps = { store, view, active: options.active ?? true, ...deps };
		latest = useAutomationsShell(shellDeps);
		return null;
	}
	await act(async () => root.render(<Probe />));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(0);
	});
	return { shell: () => latest as AutomationsShell, store, deps, bridge };
}

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window): void {
	act(() => {
		target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
	});
}

describe("selection and keys", () => {
	it("selects the first rule when the arrow goes down, and keeps going", async () => {
		const h = await mount([rule("a"), rule("b")]);
		expect(h.shell().props.selectedId).toBeNull();
		press("ArrowDown");
		expect(h.shell().props.selectedId).toBe("a");
		press("ArrowDown");
		press("ArrowDown");
		expect(h.shell().props.selectedId).toBe("b");
		press("ArrowUp");
		expect(h.shell().props.selectedId).toBe("a");
	});

	it("answers no keys while another tab has the focus", async () => {
		const h = await mount([rule("a")], { active: false });
		press("ArrowDown");
		expect(h.shell().props.selectedId).toBeNull();
	});

	it("leaves keys to a text field and to a focused button", async () => {
		const h = await mount([rule("a")]);
		const input = document.createElement("input");
		const button = document.createElement("button");
		document.body.append(input, button);
		press("ArrowDown", {}, input);
		expect(h.shell().props.selectedId).toBeNull();
		press("ArrowDown");
		press("Enter", {}, button);
		expect(h.deps.openAiDraft).not.toHaveBeenCalled();
		input.remove();
		button.remove();
	});

	it("drops a selection whose rule vanished (deleted by the agent in another tab)", async () => {
		const h = await mount([rule("a"), rule("b")]);
		press("ArrowDown");
		expect(h.shell().selectedRule?.id).toBe("a");
		await act(async () => {
			await h.store.remove("a");
		});
		expect(h.shell().selectedRule).toBeNull();
	});
});

describe("editing and adding open an AI Search draft, never a sent question", () => {
	it("Enter and double click draft the edit for that rule, in the interface language", async () => {
		const h = await mount([rule("downloads-pdf-summary")]);
		press("ArrowDown");
		press("Enter");
		expect(h.deps.openAiDraft).toHaveBeenCalledTimes(1);
		const draft = h.deps.openAiDraft.mock.calls[0]?.[0] as string;
		expect(draft).toContain("downloads-pdf-summary");
		expect(draft).toContain("다운로드에 PDF 파일이 새로 생기면");
		expect(draft.endsWith(": ")).toBe(true);

		await setAppLanguage("en");
		act(() => h.shell().props.onEdit("downloads-pdf-summary"));
		expect(h.deps.openAiDraft.mock.calls[1]?.[0]).toBe("Edit this automation rule — downloads-pdf-summary (PDF files are created in Downloads). What to change: ");
	});

	it("adding drafts the creation request", async () => {
		const h = await mount([]);
		act(() => h.shell().props.onAdd());
		expect(h.deps.openAiDraft).toHaveBeenCalledWith("새 자동화 규칙을 만들어줘. 언제, 어떤 파일에, 무엇을 할지: ");
	});

	it("ignores an edit of a rule that no longer exists", async () => {
		const h = await mount([rule("a")]);
		act(() => h.shell().props.onEdit("gone"));
		expect(h.deps.openAiDraft).not.toHaveBeenCalled();
	});
});

describe("Quick Look", () => {
	it("Space opens it on the selected rule, follows the arrows, and Space or Escape closes it", async () => {
		const h = await mount([rule("a"), rule("b")]);
		press("ArrowDown");
		press(" ");
		expect(h.shell().preview?.id).toBe("a");
		press("ArrowDown");
		expect(h.shell().preview?.id).toBe("b");
		press(" ");
		expect(h.shell().preview).toBeNull();
		press(" ");
		expect(h.shell().preview?.id).toBe("b");
		press("Escape");
		expect(h.shell().preview).toBeNull();
	});

	it("editing from Quick Look closes it and opens the draft", async () => {
		const h = await mount([rule("a")]);
		press("ArrowDown");
		press(" ");
		act(() => h.shell().editFromPreview());
		expect(h.shell().preview).toBeNull();
		expect(h.deps.openAiDraft).toHaveBeenCalledTimes(1);
	});
});

describe("deleting", () => {
	it("asks first, and Escape cancels without touching the rule", async () => {
		const h = await mount([rule("a"), rule("b")]);
		press("ArrowDown");
		press("Delete");
		expect(h.shell().confirm?.id).toBe("a");
		press("Escape");
		expect(h.shell().confirm).toBeNull();
		expect(h.store.getSnapshot().state.rules).toHaveLength(2);
	});

	it("deletes on confirm, selects the neighbour, and offers undo that expires", async () => {
		const h = await mount([rule("a"), rule("b"), rule("c")]);
		act(() => h.shell().props.onSelect("b"));
		press("Backspace", { metaKey: true });
		await act(async () => h.shell().confirmDelete());
		expect(h.store.getSnapshot().state.rules.map((item) => item.id)).toEqual(["a", "c"]);
		expect(h.shell().props.selectedId).toBe("c");
		expect(h.shell().confirm).toBeNull();
		expect(h.shell().undoToast?.message).toBe("‘새 PDF → 검색 색인 최신화’ 규칙을 삭제했어요");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_100);
		});
		expect(h.shell().undoToast).toBeNull();
	});

	it("selects the previous rule when the last one is deleted, and none when the list empties", async () => {
		const h = await mount([rule("a"), rule("b")]);
		act(() => h.shell().props.onSelect("b"));
		act(() => h.shell().props.onAskDelete("b"));
		await act(async () => h.shell().confirmDelete());
		expect(h.shell().props.selectedId).toBe("a");
		act(() => h.shell().props.onAskDelete("a"));
		await act(async () => h.shell().confirmDelete());
		expect(h.shell().props.selectedId).toBeNull();
	});

	it("undo puts the rule back and selects it", async () => {
		const h = await mount([rule("a"), rule("b")]);
		act(() => h.shell().props.onAskDelete("a"));
		await act(async () => h.shell().confirmDelete());
		await act(async () => h.shell().undoToast?.onUndo());
		expect(h.store.getSnapshot().state.rules.map((item) => item.id)).toEqual(["a", "b"]);
		expect(h.shell().props.selectedId).toBe("a");
		expect(h.shell().undoToast).toBeNull();
	});

	it("closes Quick Look when its rule is deleted", async () => {
		const h = await mount([rule("a"), rule("b")]);
		press("ArrowDown");
		press(" ");
		press("Delete");
		expect(h.shell().preview).toBeNull();
		expect(h.shell().confirm?.id).toBe("a");
	});

	it("reports a failed delete and keeps the confirm closed and the rule listed", async () => {
		const h = await mount([rule("a")], { removeFails: true });
		act(() => h.shell().props.onAskDelete("a"));
		await act(async () => h.shell().confirmDelete());
		expect(h.deps.onError).toHaveBeenCalledWith("규칙을 찾을 수 없습니다.");
		expect(h.shell().confirm).toBeNull();
		expect(h.store.getSnapshot().state.rules).toHaveLength(1);
	});

	it("delete is refused for a rule that no longer exists", async () => {
		const h = await mount([rule("a")]);
		act(() => h.shell().props.onAskDelete("gone"));
		expect(h.shell().confirm).toBeNull();
	});

	it("works from a folder inspector while the list is not the focused tab: Escape cancels, the list keys stay asleep", async () => {
		const h = await mount([rule("a"), rule("b")], { active: false });
		act(() => h.shell().askDelete(rule("a")));
		expect(h.shell().confirm?.id).toBe("a");
		press("ArrowDown");
		expect(h.shell().props.selectedId).toBeNull();
		press("Escape");
		expect(h.shell().confirm).toBeNull();
		act(() => h.shell().askDelete(rule("b")));
		await act(async () => h.shell().confirmDelete());
		expect(h.store.getSnapshot().state.rules.map((item) => item.id)).toEqual(["a"]);
		expect(h.shell().undoToast).not.toBeNull();
	});

	it("closes a right-click menu opened from a folder inspector on Escape too", async () => {
		const h = await mount([rule("a")], { active: false });
		act(() => h.shell().openRuleMenu(rule("a"), { x: 1, y: 1 }));
		expect(h.shell().menu).not.toBeNull();
		press("Escape");
		expect(h.shell().menu).toBeNull();
	});
});

describe("context menu", () => {
	it("opens for a rule at the pointer, runs its actions, and closes", async () => {
		const h = await mount([rule("a")]);
		act(() => h.shell().props.onContextMenu("a", { x: 30, y: 40 }));
		expect(h.shell().menu?.cursor).toEqual({ x: 30, y: 40 });
		expect(h.shell().menu?.entries.map((entry) => (entry.kind === "item" ? entry.action : "-"))).toEqual(["quickLook", "-", "editRule", "openRuleFolder", "addRule", "-", "deleteRule"]);
		act(() => h.shell().menuSelect("openRuleFolder", null, null, null));
		expect(h.deps.openFolder).toHaveBeenCalledWith("/Users/jeffrey/Downloads");
		expect(h.shell().menu).toBeNull();

		act(() => h.shell().props.onContextMenu("a", { x: 1, y: 2 }));
		act(() => h.shell().menuSelect("deleteRule", null, null, null));
		expect(h.shell().confirm?.id).toBe("a");
		act(() => h.shell().props.onContextMenu("a", { x: 1, y: 2 }));
		act(() => h.shell().menuSelect("quickLook", null, null, null));
		expect(h.shell().preview?.id).toBe("a");
	});

	it("freezes the list keys behind the menu and Escape closes it", async () => {
		const h = await mount([rule("a"), rule("b")]);
		act(() => h.shell().props.onContextMenu("a", { x: 1, y: 2 }));
		press("ArrowDown");
		expect(h.shell().props.selectedId).toBe("a");
		press("Escape");
		expect(h.shell().menu).toBeNull();
	});

	it("offers only adding on the empty space", async () => {
		const h = await mount([rule("a")]);
		act(() => h.shell().props.onContextMenu(null, { x: 1, y: 2 }));
		expect(h.shell().menu?.entries.map((entry) => (entry.kind === "item" ? entry.action : "-"))).toEqual(["addRule"]);
		act(() => h.shell().menuSelect("addRule", null, null, null));
		expect(h.deps.openAiDraft).toHaveBeenCalledTimes(1);
	});

	it("shows a rule in the list from a folder inspector row menu", async () => {
		const h = await mount([rule("a")]);
		act(() => h.shell().openRuleMenu(rule("a"), { x: 5, y: 6 }));
		expect(h.shell().menu?.entries.map((entry) => (entry.kind === "item" ? entry.action : "-"))).toContain("revealRule");
		act(() => h.shell().menuSelect("revealRule", null, null, null));
		expect(h.deps.showInList).toHaveBeenCalledWith("a");
		expect(h.shell().props.selectedId).toBe("a");
	});
});
