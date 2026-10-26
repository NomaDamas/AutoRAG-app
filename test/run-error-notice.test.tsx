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
	openSettings: null,
	changes: [{ path: "searchPaths", before: '["/old"]', after: '["/new"]' }],
	backupPath: "/cfg/config.json.bak-1-before-error-fix",
};

function render(message: string, props: { action?: "open-plan" | null; fix?: { onRetry: () => void } | null; onOpenSettings?: (page: string) => void } = {}): void {
	act(() =>
		root.render(
			<RunErrorNotice message={message} action={props.action ?? null} onOpenSettings={props.onOpenSettings ?? vi.fn()} fix={props.fix === undefined ? { onRetry: vi.fn() } : props.fix} />,
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

	it("tells the person what to do when only they can, with a button to the Settings page that helps", () => {
		const onOpenSettings = vi.fn();
		render("Search root /Users/me/Docs does not exist", { onOpenSettings });
		press(t("appError.fixAction"));

		emit({ type: "result", runId: runId(), result: { status: "needs-user", summary: "폴더가 옮겨진 것 같아요.", nextSteps: ["새 폴더를 골라 주세요."], openSettings: "scope", changes: [], backupPath: null } });

		const text = dialog()?.textContent ?? "";
		expect(text).toContain(t("appError.fix.status.needsUser"));
		expect(text).toContain("새 폴더를 골라 주세요.");
		expect(labels()).not.toContain(t("appError.fix.retrySearch"));

		press(t("appError.fix.openSettings", { page: t("settingsCore.nav.scope") }));

		expect(onOpenSettings).toHaveBeenCalledExactlyOnceWith("scope");
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
