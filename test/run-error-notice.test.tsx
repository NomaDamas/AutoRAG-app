// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunErrorNotice } from "../src/renderer/src/components/RunErrorNotice";
import type { ErrorFixEvent, ErrorFixRequest, ErrorFixResult } from "../src/shared/error-fix-contract";
import { setAppLanguage, t } from "../src/shared/i18n";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;
let listener: ((event: ErrorFixEvent) => void) | null;
const start = vi.fn<(runId: string, request: ErrorFixRequest) => Promise<void>>();
const cancel = vi.fn<(runId: string) => Promise<void>>();

beforeEach(async () => {
	await setAppLanguage("ko");
	listener = null;
	start.mockReset().mockImplementation(() => new Promise<void>(() => undefined));
	cancel.mockReset().mockResolvedValue(undefined);
	Reflect.set(window, "autorag", {
		errorFix: {
			start,
			cancel,
			onEvent: (next: (event: ErrorFixEvent) => void) => {
				listener = next;
				return () => {
					listener = null;
				};
			},
		},
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
	Reflect.deleteProperty(window, "autorag");
});

const buttons = (): HTMLButtonElement[] => [...document.body.querySelectorAll("button")];
const labels = (): string[] => buttons().map((button) => button.textContent ?? "");
const dialog = (): HTMLElement | null => document.body.querySelector('[role="dialog"]');
const press = (label: string): void => {
	const button = buttons().find((candidate) => candidate.textContent?.includes(label) === true || candidate.getAttribute("aria-label") === label);
	if (button === undefined) throw new Error(`no button "${label}" among ${JSON.stringify(labels())}`);
	act(() => button.click());
};
const emit = (event: ErrorFixEvent): void => {
	if (listener === null) throw new Error("the dialog is not listening");
	act(() => listener?.(event));
};
const runId = (): string => {
	const id = start.mock.calls.at(-1)?.[0];
	if (id === undefined) throw new Error("no run started");
	return id;
};

const FIXED: ErrorFixResult = {
	status: "fixed",
	summary: "검색 폴더를 Documents로 바꿨어요.",
	nextSteps: [],
	actions: [],
	changes: [{ path: "searchPaths", before: '["/old"]', after: '["/new"]' }],
	backupPath: "/cfg/config.json.bak-1-before-error-fix",
};

function render(
	message: string,
	props: { action?: "open-plan" | null; fix?: boolean; onOpenSettings?: (page: string) => void; onOpenSource?: (alias: string) => void } = {},
): void {
	act(() =>
		root.render(
			<RunErrorNotice
				message={message}
				action={props.action ?? null}
				onOpenSettings={props.onOpenSettings ?? vi.fn()}
				onOpenSource={props.onOpenSource ?? vi.fn()}
				fix={props.fix ?? true}
			/>,
		),
	);
}

describe("RunErrorNotice", () => {
	it("hides the raw error message by default behind 자세히 보기, even when short, and offers no fix button on an earlier turn", () => {
		render("Search root /Users/me/Docs does not exist", { fix: false });

		expect(host.textContent).toContain(t("appError.other.title"));
		expect(host.textContent).not.toContain("Search root /Users/me/Docs does not exist");
		expect(labels()).toEqual([t("appError.showDetails")]);

		press(t("appError.showDetails"));
		expect(host.textContent).toContain("Search root /Users/me/Docs does not exist");
	});

	it("puts the AI fix beside an app-setup error while keeping the raw error text hidden until 자세히 보기 is pressed", () => {
		render("Search root /Users/me/Docs does not exist");

		expect(host.textContent).toContain(t("appError.other.title"));
		expect(host.textContent).toContain(t("appError.other.hint"));
		expect(host.textContent).not.toContain("Search root /Users/me/Docs does not exist");
		expect(labels()).toEqual([t("appError.showDetails"), t("appError.fixAction")]);

		press(t("appError.showDetails"));
		expect(host.textContent).toContain("Search root /Users/me/Docs does not exist");
		press(t("appError.hideDetails"));
		expect(host.textContent).not.toContain("Search root /Users/me/Docs does not exist");
	});

	it("says plainly that the model cannot be used and leads to its settings and the subscription, with no AI fix", () => {
		const onOpenSettings = vi.fn();
		render("401 Incorrect API key provided", { onOpenSettings });

		expect(host.textContent).toContain(t("appError.modelCredentials.title"));
		expect(host.textContent).toContain(t("appError.modelCredentials.hint"));
		expect(host.textContent).not.toContain("401 Incorrect API key provided");
		expect(labels()).toEqual([t("appError.showDetails"), t("appError.openModelSettings"), t("aiSearch.openPlan")]);

		press(t("appError.openModelSettings"));
		press(t("aiSearch.openPlan"));

		expect(onOpenSettings.mock.calls).toEqual([["ai"], ["plan"]]);
		expect(dialog()).toBeNull();
	});

	it("goes straight to the subscription page when the main process already supplied the translated plan message", () => {
		const onOpenSettings = vi.fn();
		render("이번 주 Dazzi 크레딧을 모두 사용했습니다.", { action: "open-plan", onOpenSettings });

		expect(host.textContent).toContain("이번 주 Dazzi 크레딧을 모두 사용했습니다.");
		expect(labels()).toEqual([t("aiSearch.openPlan")]);

		press(t("aiSearch.openPlan"));
		expect(onOpenSettings).toHaveBeenCalledExactlyOnceWith("plan");
	});
});

describe("the AI fix dialog", () => {
	it("shows the self-healing animation and shimmering status text, updating live with the agent's intent without showing raw errors", () => {
		render("Search root /Users/me/Docs does not exist");

		press(t("appError.fixAction"));

		expect(dialog()).not.toBeNull();
		expect(start).toHaveBeenCalledExactlyOnceWith(expect.any(String), { message: "Search root /Users/me/Docs does not exist", surface: "ai-search" });
		expect(dialog()?.querySelector('[data-healing-state="healing"]')).not.toBeNull();
		expect(dialog()?.querySelector(".shimmer")?.textContent).toBe(t("appError.fix.running"));
		expect(dialog()?.textContent).not.toContain("Search root /Users/me/Docs does not exist");

		emit({ type: "progress", runId: runId(), text: "이동된 검색 폴더 위치 확인 중" });
		expect(dialog()?.querySelector(".shimmer")?.textContent).toBe("이동된 검색 폴더 위치 확인 중");
	});

	it("settles into the healthy state on fixed with only the Close button, never dumping config diffs, backup paths or commands", () => {
		render("Search root /Users/me/Docs does not exist");
		press(t("appError.fixAction"));

		emit({ type: "result", runId: runId(), result: FIXED });

		const text = dialog()?.textContent ?? "";
		expect(dialog()?.querySelector('[data-healing-state="healthy"]')).not.toBeNull();
		expect(text).toContain(t("appError.fix.status.fixed"));
		expect(text).toContain("검색 폴더를 Documents로 바꿨어요.");
		expect(text).not.toContain("searchPaths");
		expect(text).not.toContain("/cfg/config.json.bak");
		const footerButtons = [...(dialog()?.querySelectorAll("button") ?? [])].map((button) => button.textContent).filter((label) => label !== "");
		expect(footerButtons).toEqual([t("common.close")]);

		press(t("common.close"));
		expect(dialog()).toBeNull();
	});

	it("renders the buttons the AI returned in its tool call when user action is needed, keeping raw error details hidden behind 자세히 보기", () => {
		const onOpenSettings = vi.fn();
		render("Search root /Users/me/Docs does not exist", { onOpenSettings });
		press(t("appError.fixAction"));

		emit({
			type: "result",
			runId: runId(),
			result: {
				status: "needs-user",
				summary: "폴더가 옮겨진 것 같아요.",
				nextSteps: ["새 폴더를 골라 주세요."],
				actions: [{ kind: "settings", target: "scope", label: "검색 폴더 다시 고르기" }],
				changes: [],
				backupPath: null,
			},
		});

		const text = dialog()?.textContent ?? "";
		expect(text).toContain(t("appError.fix.status.needsUser"));
		expect(text).toContain("새 폴더를 골라 주세요.");
		expect(text).not.toContain("Search root /Users/me/Docs does not exist");

		press("검색 폴더 다시 고르기");
		expect(onOpenSettings).toHaveBeenCalledExactlyOnceWith("scope");
		expect(dialog()).toBeNull();
	});

	it("takes each kind of AI action button to its destination: a Settings page or a data source's page", () => {
		const onOpenSettings = vi.fn();
		const onOpenSource = vi.fn();
		const result = { status: "needs-user" as const, summary: "두 가지가 필요해요.", nextSteps: [], changes: [], backupPath: null };
		const actions = [
			{ kind: "source" as const, target: "kakao", label: "카카오톡 연결 열기" },
			{ kind: "settings" as const, target: "indexing" as const, label: "인덱싱 보기" },
		];
		for (const action of actions) {
			render("Search root /Users/me/Docs does not exist", { onOpenSettings, onOpenSource });
			press(t("appError.fixAction"));
			emit({ type: "result", runId: runId(), result: { ...result, actions } });
			expect(labels()).toEqual(expect.arrayContaining(actions.map((entry) => entry.label)));
			press(action.label);
		}

		expect(onOpenSource).toHaveBeenCalledExactlyOnceWith("kakao");
		expect(onOpenSettings).toHaveBeenCalledExactlyOnceWith("indexing");
	});

	it("names an AI action button without a label after where it goes, so it is never blank", () => {
		render("Search root /Users/me/Docs does not exist");
		press(t("appError.fixAction"));

		emit({
			type: "result",
			runId: runId(),
			result: {
				status: "needs-user",
				summary: "x",
				nextSteps: [],
				actions: [
					{ kind: "settings", target: "scope", label: "" },
					{ kind: "source", target: "kakao", label: "" },
				],
				changes: [],
				backupPath: null,
			},
		});

		expect(labels()).toEqual(expect.arrayContaining([t("appError.fix.openSettings", { page: t("settingsCore.nav.scope") }), t("appError.fix.openSource", { name: "kakao" })]));
	});

	it("shows only Close (plus 자세히 보기) when a cannot-fix answer has no action button", () => {
		render("Search root /Users/me/Docs does not exist");
		press(t("appError.fixAction"));

		emit({
			type: "result",
			runId: runId(),
			result: { status: "cannot-fix", summary: "제공자 서버가 응답하지 않아요. 잠시 뒤에 다시 해 보세요.", nextSteps: ["몇 분 뒤에 다시 시도하세요."], actions: [], changes: [], backupPath: null },
		});

		const modalButtons = [...(dialog()?.querySelectorAll("button") ?? [])].map((button) => button.textContent).filter((label) => label !== "");
		expect(modalButtons).toEqual([t("appError.showDetails"), t("common.close")]);
	});

	it("explains a model that stopped working during the fix and keeps its raw message hidden until 자세히 보기 is opened", () => {
		const onOpenSettings = vi.fn();
		render("Search root /Users/me/Docs does not exist", { onOpenSettings });
		press(t("appError.fixAction"));

		emit({ type: "error", runId: runId(), message: 'dazzi API error (401): {"code":"invalid_api_key"}', changes: [], backupPath: null });

		const text = dialog()?.textContent ?? "";
		expect(text).toContain(t("appError.modelCredentials.title"));
		expect(text).toContain(t("appError.modelCredentials.hint"));
		expect(text).not.toContain("invalid_api_key");

		const detailBtn = [...(dialog()?.querySelectorAll("button") ?? [])].find((btn) => btn.textContent === t("appError.showDetails"));
		act(() => detailBtn?.click());
		expect(dialog()?.textContent).toContain("invalid_api_key");

		press(t("appError.openModelSettings"));
		expect(onOpenSettings).toHaveBeenCalledExactlyOnceWith("ai");
	});

	it("hides a non-model failure's raw error behind 자세히 보기 and offers Retry", () => {
		render("Search root /Users/me/Docs does not exist");
		press(t("appError.fixAction"));
		emit({ type: "error", runId: runId(), message: "The AI ended without reporting a result.", changes: [], backupPath: null });

		expect(dialog()?.textContent).toContain(t("appError.fix.failedTitle"));
		expect(dialog()?.textContent).not.toContain("The AI ended without reporting a result.");

		const detailBtn = [...(dialog()?.querySelectorAll("button") ?? [])].find((btn) => btn.textContent === t("appError.showDetails"));
		act(() => detailBtn?.click());
		expect(dialog()?.textContent).toContain("The AI ended without reporting a result.");

		press(t("common.retry"));
		expect(start).toHaveBeenCalledTimes(2);
		expect(dialog()?.querySelector(".shimmer")?.textContent).toBe(t("appError.fix.running"));
	});

	it("stops the run when Stop is pressed or the dialog is closed", () => {
		render("Search root /Users/me/Docs does not exist");
		press(t("appError.fixAction"));
		const id = runId();

		press(t("aiSearch.stop"));
		expect(cancel).toHaveBeenCalledWith(id);
		emit({ type: "cancelled", runId: id, changes: [], backupPath: null });
		expect(dialog()?.textContent).toContain(t("appError.fix.stopped"));

		press(t("common.close"));
		expect(dialog()).toBeNull();
	});

	it("cancels a running fix when the dialog is closed", () => {
		render("Search root /Users/me/Docs does not exist");
		press(t("appError.fixAction"));
		const id = runId();

		press(t("common.close"));
		expect(cancel).toHaveBeenCalledWith(id);
		expect(dialog()).toBeNull();
	});

	it("shows a start that the bridge rejects as a failure with raw details hidden until opened", async () => {
		start.mockRejectedValueOnce(new Error("errorFix:start expects a run id"));
		render("Search root /Users/me/Docs does not exist");

		await act(async () => buttons().find((button) => button.textContent === t("appError.fixAction"))?.click());

		expect(dialog()?.textContent).toContain(t("appError.fix.failedTitle"));
		expect(dialog()?.textContent).not.toContain("errorFix:start expects a run id");
	});
});
