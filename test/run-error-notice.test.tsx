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

/** Buttons of the notice itself, then of the dialog when one is open. */
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
	props: { action?: "open-plan" | null; fix?: { onRetry: () => void } | null; onOpenSettings?: (page: string) => void; onOpenSource?: (alias: string) => void } = {},
): void {
	act(() =>
		root.render(
			<RunErrorNotice
				message={message}
				action={props.action ?? null}
				onOpenSettings={props.onOpenSettings ?? vi.fn()}
				onOpenSource={props.onOpenSource ?? vi.fn()}
				fix={props.fix === undefined ? { onRetry: vi.fn() } : props.fix}
			/>,
		),
	);
}

describe("RunErrorNotice", () => {
	it("leaves an error of an earlier turn as plain words: nothing to fix there any more", () => {
		render("Search root /Users/me/Docs does not exist", { fix: null });

		expect(host.textContent).toContain("Search root /Users/me/Docs does not exist");
		expect(buttons()).toHaveLength(0);
	});

	it("puts the AI fix beside an error about the app's own setup, with the message still readable", () => {
		render("Search root /Users/me/Docs does not exist");

		expect(host.textContent).toContain(t("appError.other.title"));
		expect(host.textContent).toContain("Search root /Users/me/Docs does not exist");
		expect(labels()).toEqual([t("appError.fixAction")]);
	});

	it("says plainly that the model cannot be used and leads to its settings and the subscription, with no AI fix", () => {
		const onOpenSettings = vi.fn();
		render("401 Incorrect API key provided", { onOpenSettings });

		expect(host.textContent).toContain(t("appError.modelCredentials.title"));
		expect(host.textContent).toContain(t("appError.modelCredentials.hint"));
		expect(host.textContent).toContain("401 Incorrect API key provided");
		expect(labels()).toEqual([t("appError.openModelSettings"), t("aiSearch.openPlan")]);

		press(t("appError.openModelSettings"));
		press(t("aiSearch.openPlan"));

		expect(onOpenSettings.mock.calls).toEqual([["ai"], ["plan"]]);
		expect(dialog()).toBeNull();
	});

	it("still goes straight to the subscription page when the main process says the plan is the problem", () => {
		const onOpenSettings = vi.fn();
		render("이번 주 Dazzi 크레딧을 모두 사용했습니다.", { action: "open-plan", onOpenSettings });

		expect(host.textContent).toContain("이번 주 Dazzi 크레딧을 모두 사용했습니다.");
		expect(labels()).toEqual([t("aiSearch.openPlan")]);
		expect(t("aiSearch.openPlan")).toContain(t("settingsCore.nav.plan"));

		press(t("aiSearch.openPlan"));

		expect(onOpenSettings).toHaveBeenCalledExactlyOnceWith("plan");
	});

	describe("technical details", () => {
		const RAW = 'dazzi API error (401): {"message":"Invalid or revoked API key.","type":"invalid_request_error","code":"invalid_api_key"}';

		it("hides codes and JSON behind a details button: the person sees the plain title and hint, not the provider's body", () => {
			render(RAW);

			expect(host.textContent).toContain(t("appError.modelCredentials.title"));
			expect(host.textContent).not.toContain("invalid_request_error");
			expect(host.textContent).not.toContain("invalid_api_key");
			expect(labels()).toContain(t("appError.showDetails"));
		});

		it("shows the original message in full when the details are opened, and hides it again", () => {
			render(RAW);

			press(t("appError.showDetails"));
			expect(host.textContent).toContain(RAW);
			expect(labels()).toContain(t("appError.hideDetails"));

			press(t("appError.hideDetails"));
			expect(host.textContent).not.toContain("invalid_request_error");
		});

		it("gives the details button no place among the actions: it is a quiet link under the message, and the action buttons are unchanged", () => {
			render(RAW);

			const actions = [...host.querySelectorAll("button")].filter((button) => button.textContent !== t("appError.showDetails")).map((button) => button.textContent);
			expect(actions).toEqual([t("appError.openModelSettings"), t("aiSearch.openPlan")]);
		});

		it("shows no details button for a short plain message, which is shown as it is", () => {
			render("Search root /Users/me/Docs does not exist");

			expect(host.textContent).toContain("Search root /Users/me/Docs does not exist");
			expect(labels()).not.toContain(t("appError.showDetails"));
		});

		it("keeps the details of an earlier turn's error behind the button too", () => {
			render(RAW, { fix: null });

			expect(host.textContent).not.toContain("invalid_api_key");
			press(t("appError.showDetails"));
			expect(host.textContent).toContain("invalid_api_key");
		});
	});
});

describe("the AI fix dialog", () => {
	it("starts a run for the error as shown and lists what the agent does while it works", () => {
		render("Search root /Users/me/Docs does not exist");

		press(t("appError.fixAction"));

		expect(dialog()).not.toBeNull();
		expect(start).toHaveBeenCalledExactlyOnceWith(expect.any(String), { message: "Search root /Users/me/Docs does not exist", surface: "ai-search" });
		expect(dialog()?.textContent).toContain(t("appError.fix.running"));

		emit({ type: "step", runId: runId(), step: { tool: "diagnose", detail: null } });
		emit({ type: "step", runId: runId(), step: { tool: "check_path", detail: "/Users/me/Documents" } });

		expect(dialog()?.textContent).toContain(t("appError.fix.steps.diagnose"));
		expect(dialog()?.textContent).toContain(`${t("appError.fix.steps.checkPath")}: /Users/me/Documents`);
	});

	it("shows what was fixed, what changed and where the old config is kept, and asks the question again on request", () => {
		const onRetry = vi.fn();
		render("Search root /Users/me/Docs does not exist", { fix: { onRetry } });
		press(t("appError.fixAction"));

		emit({ type: "result", runId: runId(), result: FIXED });

		const text = dialog()?.textContent ?? "";
		expect(text).toContain(t("appError.fix.status.fixed"));
		expect(text).toContain("검색 폴더를 Documents로 바꿨어요.");
		expect(text).toContain("searchPaths");
		expect(text).toContain('["/new"]');
		expect(text).toContain("/cfg/config.json.bak-1-before-error-fix");

		press(t("appError.fix.retrySearch"));

		expect(onRetry).toHaveBeenCalledOnce();
		expect(dialog()).toBeNull();
	});

	it("tells the person what to do when only they can, with the buttons the AI chose, labelled the way the AI wrote them", () => {
		const onOpenSettings = vi.fn();
		render("Search root /Users/me/Docs does not exist", { onOpenSettings });
		press(t("appError.fixAction"));

		emit({
			type: "result",
			runId: runId(),
			result: { status: "needs-user", summary: "폴더가 옮겨진 것 같아요.", nextSteps: ["새 폴더를 골라 주세요."], actions: [{ kind: "settings", target: "scope", label: "검색 폴더 다시 고르기" }], changes: [], backupPath: null },
		});

		const text = dialog()?.textContent ?? "";
		expect(text).toContain(t("appError.fix.status.needsUser"));
		expect(text).toContain("새 폴더를 골라 주세요.");
		expect(labels()).not.toContain(t("appError.fix.retrySearch"));

		press("검색 폴더 다시 고르기");

		expect(onOpenSettings).toHaveBeenCalledExactlyOnceWith("scope");
		expect(dialog()).toBeNull();
	});

	it("takes each kind of button to its own place: a Settings page, a data source's page", () => {
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

	it("names a button without a label after where it goes, so it is never blank", () => {
		render("Search root /Users/me/Docs does not exist");
		press(t("appError.fixAction"));

		emit({
			type: "result",
			runId: runId(),
			result: { status: "needs-user", summary: "x", nextSteps: [], actions: [{ kind: "settings", target: "scope", label: "" }, { kind: "source", target: "kakao", label: "" }], changes: [], backupPath: null },
		});

		expect(labels()).toEqual(expect.arrayContaining([t("appError.fix.openSettings", { page: t("settingsCore.nav.scope") }), t("appError.fix.openSource", { name: "kakao" })]));
	});

	it("shows only Close when the answer has no button: an explanation with nowhere to send the person is a complete answer", () => {
		render("Search root /Users/me/Docs does not exist");
		press(t("appError.fixAction"));

		emit({ type: "result", runId: runId(), result: { status: "cannot-fix", summary: "제공자 서버가 응답하지 않아요. 잠시 뒤에 다시 해 보세요.", nextSteps: ["몇 분 뒤에 다시 시도하세요."], actions: [], changes: [], backupPath: null } });

		const text = dialog()?.textContent ?? "";
		expect(text).toContain(t("appError.fix.status.cannotFix"));
		expect(text).toContain("제공자 서버가 응답하지 않아요.");
		expect([...(dialog()?.querySelectorAll("button") ?? [])].map((button) => button.textContent).filter((label) => label !== "")).toEqual([t("common.close")]);
	});

	it("explains a model that stopped working during the fix the same way as any other model error", () => {
		const onOpenSettings = vi.fn();
		render("Search root /Users/me/Docs does not exist", { onOpenSettings });
		press(t("appError.fixAction"));

		emit({ type: "error", runId: runId(), message: "401 Incorrect API key provided", changes: [], backupPath: null });

		const text = dialog()?.textContent ?? "";
		expect(text).toContain(t("appError.modelCredentials.title"));
		expect(text).toContain(t("appError.modelCredentials.hint"));
		press(t("appError.openModelSettings"));
		expect(onOpenSettings).toHaveBeenCalledExactlyOnceWith("ai");
	});

	it("reports a failure that is not about the model with the message and offers another try", () => {
		render("Search root /Users/me/Docs does not exist");
		press(t("appError.fixAction"));
		emit({ type: "error", runId: runId(), message: "The AI ended without reporting a result.", changes: [], backupPath: null });

		expect(dialog()?.textContent).toContain(t("appError.fix.failedTitle"));
		expect(dialog()?.textContent).toContain("The AI ended without reporting a result.");

		press(t("common.retry"));

		expect(start).toHaveBeenCalledTimes(2);
		expect(dialog()?.textContent).toContain(t("appError.fix.running"));
	});

	it("keeps a provider's JSON out of the dialog until the details are opened, both for the error being fixed and for a failure of the fix", () => {
		const raw = 'dazzi API error (429): {"message":"Too many requests","type":"rate_limit_error","code":"rate_limit_exceeded"}';
		// An error of the app's own setup with a long technical tail: the AI fix is offered.
		render("Error: boom\n    at run (/app/out/main/index.js:1:1)");
		press(t("appError.fixAction"));
		const toggles = (): HTMLButtonElement[] => [...(dialog()?.querySelectorAll("button") ?? [])].filter((button) => button.textContent === t("appError.showDetails"));

		expect(dialog()?.textContent).not.toContain("/app/out/main/index.js");
		act(() => toggles()[0]?.click());
		expect(dialog()?.textContent).toContain("/app/out/main/index.js");

		emit({ type: "error", runId: runId(), message: raw, changes: [], backupPath: null });
		expect(dialog()?.textContent).not.toContain("rate_limit_exceeded");
		act(() => toggles().at(-1)?.click());

		expect(dialog()?.textContent).toContain("rate_limit_exceeded");
	});

	it("does not hide a change made before the run failed", () => {
		render("Search root /Users/me/Docs does not exist");
		press(t("appError.fixAction"));

		emit({ type: "error", runId: runId(), message: "provider exploded", changes: FIXED.changes, backupPath: FIXED.backupPath });

		expect(dialog()?.textContent).toContain("searchPaths");
		expect(dialog()?.textContent).toContain("/cfg/config.json.bak-1-before-error-fix");
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

	it("shows a start that the bridge rejects as a failure rather than waiting forever", async () => {
		start.mockRejectedValueOnce(new Error("errorFix:start expects a run id"));
		render("Search root /Users/me/Docs does not exist");

		await act(async () => buttons().find((button) => button.textContent === t("appError.fixAction"))?.click());

		expect(dialog()?.textContent).toContain(t("appError.fix.failedTitle"));
		expect(dialog()?.textContent).toContain("errorFix:start expects a run id");
	});
});
