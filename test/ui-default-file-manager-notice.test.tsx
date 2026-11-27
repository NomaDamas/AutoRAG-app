// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppLanguage } from "../src/shared/i18n";
import type { DefaultFileManagerStatus } from "../src/shared/default-file-manager-contract";
import { NotificationCenter } from "../src/renderer/src/components/NotificationCenter";
import { resetNotificationsForTests } from "../src/renderer/src/state/notifications";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeDfmStatus(overrides: Partial<DefaultFileManagerStatus> = {}): DefaultFileManagerStatus {
	return {
		supported: true,
		platform: "darwin",
		enabled: false,
		osRegistered: false,
		interceptReveal: false,
		interceptRevealActive: false,
		macRevealHookLoaded: true,
		requiresPackagedApp: false,
		error: null,
		...overrides,
	};
}

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
	await setAppLanguage("ko");
	resetNotificationsForTests();
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	host.remove();
	document.body.innerHTML = "";
	Reflect.deleteProperty(window, "autorag");
});

describe("NotificationCenter default file manager prompt", () => {
	function installStub(options: {
		signedIn: boolean;
		dfmStatus: DefaultFileManagerStatus;
		apply?: (req: { enabled: boolean; interceptReveal?: boolean }) => Promise<DefaultFileManagerStatus>;
	}) {
		const applyMock = vi.fn(
			options.apply ??
				(async (req) => ({
					...options.dfmStatus,
					enabled: req.enabled,
					osRegistered: req.enabled,
					interceptReveal: req.interceptReveal ?? false,
				})),
		);
		Reflect.set(window, "autorag", {
			platform: options.dfmStatus.platform === "win32" ? "win32" : "darwin",
			settings: {
				sourcesList: vi.fn(async () => ({ sources: [] })),
			},
			indexProblem: {
				get: vi.fn(async () => ({ kind: "none", at: null, failure: null })),
				onChange: vi.fn(() => () => undefined),
				retry: vi.fn(),
				dismiss: vi.fn(),
			},
			account: {
				status: vi.fn(async () => ({
					state: options.signedIn ? "signedIn" : "signedOut",
					account: null,
					offline: false,
					error: null,
					baseUrl: "https://api.dazziapp.com",
				})),
				onChanged: vi.fn(() => () => undefined),
			},
			defaultFileManager: {
				status: vi.fn(async () => options.dfmStatus),
				apply: applyMock,
				onChange: vi.fn(() => () => undefined),
			},
		});
		return { applyMock };
	}

	it("shows the default file manager prompt once onboarding is done and user is signed in, and enables on click", async () => {
		const { applyMock } = installStub({ signedIn: true, dfmStatus: makeDfmStatus() });
		const onOpenSettingsPage = vi.fn();

		await act(async () => {
			root.render(<NotificationCenter onboardingPending={false} onOpenSettingsPage={onOpenSettingsPage} />);
			await flush();
		});

		const bell = host.querySelector<HTMLButtonElement>('[data-action="open-notifications"]');
		expect(bell).not.toBeNull();
		// Unread dot should be shown because the active prompt is present.
		expect(bell?.querySelector(".bg-danger-dot")).not.toBeNull();

		await act(async () => {
			bell?.click();
			await flush();
		});

		const panel = document.body.querySelector(".notification-center");
		expect(panel?.textContent).toContain("Dazzi를 기본 파일 관리자로 설정할까요?");

		const enableBtn = [...(panel?.querySelectorAll("button") ?? [])].find((btn) => btn.textContent === "지금 설정");
		expect(enableBtn).not.toBeUndefined();

		await act(async () => {
			enableBtn?.click();
			await flush();
		});

		expect(applyMock).toHaveBeenCalledWith({ enabled: true, interceptReveal: true });
		// Prompt disappears once enabled.
		expect(document.body.querySelector(".notification-center")?.textContent).not.toContain("Dazzi를 기본 파일 관리자로 설정할까요?");
	});

	it("stays hidden while onboarding is pending or while signed out", async () => {
		installStub({ signedIn: false, dfmStatus: makeDfmStatus() });

		await act(async () => {
			root.render(<NotificationCenter onboardingPending={false} />);
			await flush();
		});

		const bell = host.querySelector<HTMLButtonElement>('[data-action="open-notifications"]');
		expect(bell?.querySelector(".bg-danger-dot")).toBeNull();

		installStub({ signedIn: true, dfmStatus: makeDfmStatus() });
		await act(async () => {
			root.render(<NotificationCenter onboardingPending={true} />);
			await flush();
		});
		expect(bell?.querySelector(".bg-danger-dot")).toBeNull();
	});

	it("enables interceptReveal too when activated from the notification on Windows", async () => {
		const { applyMock } = installStub({ signedIn: true, dfmStatus: makeDfmStatus({ platform: "win32" }) });

		await act(async () => {
			root.render(<NotificationCenter onboardingPending={false} />);
			await flush();
		});

		await act(async () => {
			host.querySelector<HTMLButtonElement>('[data-action="open-notifications"]')?.click();
			await flush();
		});

		const panel = document.body.querySelector(".notification-center");
		expect(panel?.textContent).toContain("Win+E");
		const enableBtn = [...(panel?.querySelectorAll("button") ?? [])].find((btn) => btn.textContent === "지금 설정");
		await act(async () => {
			enableBtn?.click();
			await flush();
		});
		expect(applyMock).toHaveBeenCalledWith({ enabled: true, interceptReveal: true });
	});
});
