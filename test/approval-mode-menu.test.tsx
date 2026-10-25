// @vitest-environment happy-dom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalModeMenu, useApprovalMode } from "../src/renderer/src/components/ApprovalModeMenu";
import { APPROVAL_MODES, type ApprovalMode } from "../src/shared/interaction-contract";
import { setAppLanguage, t } from "../src/shared/i18n";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let modeListeners: ((mode: ApprovalMode) => void)[] = [];
const getMode = vi.fn(async () => "ask" as ApprovalMode);
const setMode = vi.fn(async (mode: ApprovalMode) => mode);
const onMode = vi.fn((listener: (mode: ApprovalMode) => void) => {
	modeListeners.push(listener);
	return () => {
		modeListeners = modeListeners.filter((candidate) => candidate !== listener);
	};
});

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
	await setAppLanguage("ko");
	modeListeners = [];
	getMode.mockReset();
	setMode.mockReset();
	onMode.mockClear();
	getMode.mockImplementation(async () => "ask");
	setMode.mockImplementation(async (mode: ApprovalMode) => mode);
	Reflect.set(globalThis, "autorag", { interaction: { getMode, setMode, onMode } });
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	Reflect.deleteProperty(globalThis, "autorag");
});

/** The panel's own wiring: the mode hook drives the pill. */
function Harness(): ReactElement {
	const { mode, setMode: change } = useApprovalMode();
	return <ApprovalModeMenu mode={mode} onChange={change} />;
}

/** Mount and let the `getMode` read land. */
async function renderHarness(): Promise<void> {
	await act(async () => {
		root.render(<Harness />);
	});
}

const trigger = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;

const items = (): HTMLButtonElement[] => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];

function press(target: EventTarget, key: string): void {
	act(() => target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
}

describe("ApprovalModeMenu", () => {
	it("shows Auto while the first read is still pending", () => {
		getMode.mockImplementation(() => new Promise<ApprovalMode>(() => undefined));
		act(() => root.render(<Harness />));
		expect(trigger().textContent).toContain(t("interaction.mode.auto.label"));
	});

	it("shows the stored mode the read answers with", async () => {
		await renderHarness();
		expect(getMode).toHaveBeenCalledTimes(1);
		expect(trigger().textContent).toContain(t("interaction.mode.ask.label"));
	});

	it("lists the three modes with a description each, and marks the current one", async () => {
		await renderHarness();
		act(() => trigger().click());

		expect(items()).toHaveLength(APPROVAL_MODES.length);
		expect(host.textContent).toContain(t("interaction.mode.full.desc"));
		const checked = items().filter((item) => item.getAttribute("aria-checked") === "true");
		expect(checked).toHaveLength(1);
		expect(checked[0]?.textContent).toContain(t("interaction.mode.ask.label"));
	});

	it("persists the picked mode and shows what the main process resolved to", async () => {
		setMode.mockImplementation(async () => "full");
		await renderHarness();
		act(() => trigger().click());

		const full = items().find((item) => item.textContent?.includes(t("interaction.mode.full.label")));
		await act(async () => {
			full?.click();
		});

		expect(setMode).toHaveBeenCalledWith("full");
		expect(trigger().textContent).toContain(t("interaction.mode.full.label"));
		expect(items()).toHaveLength(0);
	});

	it("adopts the mode setMode returns even when it differs from the request", async () => {
		setMode.mockImplementation(async () => "auto");
		await renderHarness();
		act(() => trigger().click());

		const full = items().find((item) => item.textContent?.includes(t("interaction.mode.full.label")));
		await act(async () => {
			full?.click();
		});

		expect(trigger().textContent).toContain(t("interaction.mode.auto.label"));
	});

	it("follows a mode another window or the main process pushes", async () => {
		await renderHarness();
		expect(onMode).toHaveBeenCalled();

		act(() => {
			for (const listener of modeListeners) listener("full");
		});
		expect(trigger().textContent).toContain(t("interaction.mode.full.label"));
	});

	it("opens on ArrowDown, moves focus with the arrow keys, and closes on Escape", async () => {
		await renderHarness();
		press(trigger(), "ArrowDown");
		const menu = host.querySelector('[role="menu"]');
		expect(menu).not.toBeNull();

		press(menu!, "ArrowDown");
		const focused = document.activeElement;
		expect(focused instanceof HTMLButtonElement && items().includes(focused)).toBe(true);

		press(menu!, "Escape");
		expect(items()).toHaveLength(0);
	});
});
