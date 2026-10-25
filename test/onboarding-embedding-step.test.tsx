// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { AccountStatus } from "../src/shared/account-contract";
import type { ModelDownloadStatus } from "../src/shared/model-download-contract";
import type { EmbedMode, FolderScan, OnboardingDraft } from "../src/shared/onboarding-contract";
import { EmbeddingStep } from "../src/renderer/src/onboarding/steps/Embedding";
import type { OnboardingCtx } from "../src/renderer/src/onboarding/context";
import type { Translate } from "../src/renderer/src/onboarding/flow";
import type { LocalSpecVerdict } from "../src/shared/local-embedding-spec";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

const signedIn: AccountStatus = {
	state: "signedIn",
	account: null,
	offline: false,
	error: null,
	baseUrl: "https://api.example.test",
};

const scans = new Map<string, FolderScan>([
	["/a", { path: "/a", files: 4_000, bytes: 1, onlineOnly: 0, done: true, error: null }],
]);

/** The step's copy is irrelevant here, so the key comes back verbatim with its variables. */
const stubTranslate: Translate = (key, options) =>
	options === undefined ? key : `${key} ${Object.entries(options).map(([name, value]) => `${name}=${String(value)}`).join(" ")}`;

interface Harness {
	readonly ctx: OnboardingCtx;
	readonly setEmbedMode: Mock<(mode: EmbedMode) => void>;
	readonly setCloudConsent: Mock<(consent: boolean) => void>;
	readonly startDownload: Mock<() => void>;
	readonly toast: Mock<(message: string) => void>;
}

function harness(options: {
	readonly embed: EmbedMode;
	readonly consent?: boolean;
	readonly account?: AccountStatus | null;
	readonly download?: ModelDownloadStatus;
	readonly localModel?: boolean;
	readonly localSpec?: LocalSpecVerdict;
}): Harness {
	const setEmbedMode = vi.fn();
	const setCloudConsent = vi.fn();
	const startDownload = vi.fn();
	const toast = vi.fn();
	const draft: OnboardingDraft = {
		version: 1,
		stepId: "embedding",
		notifications: false,
		network: false,
		launchAtLogin: false,
		folders: [{ path: "/a", selected: true }],
		embed: options.embed,
		cloudConsent: options.consent === true,
		sources: [],
		plan: "pro",
		planConfirmed: false,
		model: null,
	};
	const noop = (): void => undefined;
	const ctx: OnboardingCtx = {
		draft,
		platform: "darwin",
		permissions: null,
		fdaPending: false,
		scanning: false,
		scans,
		candidates: [],
		embedding: { profile: "qwen3", modelBytes: 614_000_000, cached: false, configured: false, localModel: options.localModel ?? true, localSpec: options.localSpec ?? { eligible: true } },
		modelDownload: { status: options.download ?? { state: "absent", bytesDone: 0, bytesTotal: 614_000_000, file: null, error: null }, start: startDownload, cancel: noop },
		sources: [],
		sourcesChecking: false,
		indexStatus: null,
		smartRun: { status: "idle" },
		shareErrors: false,
		account: options.account === undefined ? signedIn : options.account,
		paying: false,
		tipIndex: 0,
		shareUsage: false,
		t: stubTranslate,
		patch: noop,
		setStep: noop,
		next: noop,
		back: noop,
		toast,
		openOverlay: noop,
		closeOverlay: noop,
		setFolderSelected: noop,
		addFolders: noop,
		setEmbedMode,
		setCloudConsent,
		setSourceOn: noop,
		choosePlan: noop,
		signIn: noop,
		cancelSignIn: noop,
		signOut: noop,
		skipAccount: noop,
		openCheckout: noop,
		refreshAccount: noop,
		setLaunchAtLogin: noop,
		setShareUsage: noop,
		setShareErrors: noop,
		toggleAllFolders: noop,
		startSmartScan: noop,
		cancelSmartScan: noop,
		rescanSmart: noop,
		setSmartExcluded: noop,
		addExclusion: noop,
		requestNotifications: noop,
		openNotificationSettings: noop,
		checkNetwork: noop,
		startIndexing: noop,
		changeEmbedding: noop,
		excludeFolders: noop,
		finish: noop,
		finishInBackground: noop,
		setTipIndex: noop,
		dragApp: noop,
		relaunch: noop,
		openFullDiskAccess: noop,
	};
	return { ctx, setEmbedMode, setCloudConsent, startDownload, toast };
}

function render(ctx: OnboardingCtx): void {
	act(() => root.render(<EmbeddingStep ctx={ctx} />));
}

function card(mode: EmbedMode): HTMLElement {
	const element = host.querySelector<HTMLElement>(`[data-value="${mode}"]`);
	if (element === null) throw new Error(`no ${mode} card`);
	return element;
}

function click(element: HTMLElement): void {
	act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function key(element: HTMLElement, name: string): void {
	act(() => element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })));
}

describe("EmbeddingStep", () => {
	it("renders the three modes as radios in one radiogroup, none checked by default", () => {
		const { ctx } = harness({ embed: "none" });
		render(ctx);
		const group = host.querySelector('[role="radiogroup"]');
		expect(group).not.toBeNull();
		const radios = [...host.querySelectorAll<HTMLElement>('[role="radio"]')];
		expect(radios.map((radio) => radio.dataset.value)).toEqual(["none", "local", "cloud"]);
		expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
		expect(radios.every((radio) => radio.getAttribute("aria-disabled") === "false")).toBe(true);
		// Two meters of four pips on every card.
		for (const mode of ["none", "local", "cloud"] as const) {
			expect(card(mode).querySelectorAll(".em-meter")).toHaveLength(2);
			expect(card(mode).querySelectorAll(".em-pips i")).toHaveLength(8);
		}
	});

	it("selects the mode a card is clicked for", () => {
		const { ctx, setEmbedMode } = harness({ embed: "none" });
		render(ctx);
		click(card("local"));
		expect(setEmbedMode).toHaveBeenLastCalledWith("local");
		click(card("cloud"));
		expect(setEmbedMode).toHaveBeenLastCalledWith("cloud");
		click(card("none"));
		expect(setEmbedMode).toHaveBeenLastCalledWith("none");
	});

	it("marks the stored mode as checked", () => {
		const { ctx } = harness({ embed: "local" });
		render(ctx);
		expect(card("local").getAttribute("aria-checked")).toBe("true");
		expect(card("none").getAttribute("aria-checked")).toBe("false");
	});

	it("renders the cloud card disabled and ignores its clicks while signed out", () => {
		const { ctx, setEmbedMode } = harness({ embed: "none", account: null });
		render(ctx);
		const cloud = card("cloud");
		expect(cloud.getAttribute("aria-disabled")).toBe("true");
		expect(cloud.className).toContain("disabled");
		click(cloud);
		expect(setEmbedMode).not.toHaveBeenCalled();
		// The two local cards stay usable.
		click(card("local"));
		expect(setEmbedMode).toHaveBeenLastCalledWith("local");
	});

	it("shows the consent only for the cloud mode and reports its checkbox", () => {
		const none = harness({ embed: "none" });
		render(none.ctx);
		expect(host.querySelector(".em-consent")).toBeNull();

		const cloud = harness({ embed: "cloud" });
		render(cloud.ctx);
		const consent = host.querySelector<HTMLElement>(".em-consent");
		expect(consent).not.toBeNull();
		const input = consent?.querySelector<HTMLInputElement>("input");
		expect(input?.checked).toBe(false);
		if (input !== null && input !== undefined) {
			// A checkbox click toggles it and React maps that to `change`.
			act(() => input.click());
		}
		expect(cloud.setCloudConsent).toHaveBeenLastCalledWith(true);
	});

	it("shows the model download under the cards only while on-device embedding is chosen, and starts it from there", () => {
		for (const embed of ["none", "cloud"] as const) {
			render(harness({ embed }).ctx);
			expect(host.querySelector(".model-dl")).toBeNull();
		}

		const local = harness({ embed: "local" });
		render(local.ctx);
		expect(host.querySelector(".model-dl")).not.toBeNull();
		click([...host.querySelectorAll<HTMLButtonElement>(".model-dl button")].find((button) => button.textContent?.includes("modelDownload.download")) as HTMLElement);
		expect(local.startDownload).toHaveBeenCalledTimes(1);
	});

	it("shows live progress in the step and nothing to download once the model is on this computer", () => {
		render(harness({ embed: "local", download: { state: "downloading", bytesDone: 307_000_000, bytesTotal: 614_000_000, file: "model.safetensors", error: null } }).ctx);
		expect(host.querySelector('.model-dl [role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("50");

		render(harness({ embed: "local", download: { state: "ready", bytesDone: 614_000_000, bytesTotal: 614_000_000, file: null, error: null } }).ctx);
		expect(host.querySelector(".model-dl")?.getAttribute("data-state")).toBe("ready");
		expect(host.querySelectorAll(".model-dl button")).toHaveLength(0);
	});

	it("offers no download when the config already names a server of the user's own", () => {
		render(harness({ embed: "local", localModel: false }).ctx);
		expect(host.querySelector(".model-dl")).toBeNull();
	});

	it("selects the focused card with Enter or Space", () => {
		const { ctx, setEmbedMode } = harness({ embed: "none" });
		render(ctx);
		key(card("local"), "Enter");
		expect(setEmbedMode).toHaveBeenLastCalledWith("local");
		key(card("cloud"), " ");
		expect(setEmbedMode).toHaveBeenLastCalledWith("cloud");
	});

	it("moves the selection with the arrow keys, skipping the disabled card", () => {
		const { ctx, setEmbedMode } = harness({ embed: "none", account: null });
		render(ctx);
		key(card("none"), "ArrowRight");
		expect(setEmbedMode).toHaveBeenLastCalledWith("local");
		key(card("local"), "ArrowRight");
		expect(setEmbedMode).toHaveBeenLastCalledWith("none");
	});

	describe("on a machine below the local spec", () => {
		const weak: LocalSpecVerdict = { eligible: false, reason: "apple-base-chip", vars: { chip: "Apple M2" } };

		it("shows the local card disabled with the reason on the card, and leaves the other two usable", () => {
			const { ctx } = harness({ embed: "none", localSpec: weak });
			render(ctx);
			expect(card("local").getAttribute("aria-disabled")).toBe("true");
			expect(card("local").className).toContain("disabled");
			expect(card("none").getAttribute("aria-disabled")).toBe("false");
			expect(card("cloud").getAttribute("aria-disabled")).toBe("false");
			expect(card("local").querySelector(".em-blocked")?.textContent).toContain("localSpec.reason.appleBaseChip");
			expect(card("none").querySelector(".em-blocked")).toBeNull();
		});

		it("explains instead of selecting when the local card is clicked or chosen with the keyboard", () => {
			const { ctx, setEmbedMode, toast } = harness({ embed: "none", localSpec: weak });
			render(ctx);
			click(card("local"));
			expect(setEmbedMode).not.toHaveBeenCalled();
			expect(toast).toHaveBeenCalledTimes(1);
			expect(toast.mock.calls[0]?.[0]).toContain("localSpec.blocked");
			expect(toast.mock.calls[0]?.[0]).toContain("localSpec.reason.appleBaseChip");
			key(card("local"), "Enter");
			expect(toast).toHaveBeenCalledTimes(2);
			expect(setEmbedMode).not.toHaveBeenCalled();
		});

		it("skips the local card when the arrow keys walk the group", () => {
			const { ctx, setEmbedMode } = harness({ embed: "none", localSpec: weak });
			render(ctx);
			key(card("none"), "ArrowRight");
			expect(setEmbedMode).toHaveBeenLastCalledWith("cloud");
		});
	});

	it("shows no blocked line when the machine meets the spec", () => {
		const { ctx } = harness({ embed: "none" });
		render(ctx);
		expect(host.querySelector(".em-blocked")).toBeNull();
	});
});
