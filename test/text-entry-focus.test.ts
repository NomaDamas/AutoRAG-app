import { describe, expect, it, vi } from "vitest";
import { focusTextEntry, type TextEntryWindow } from "../src/preview/node/text-entry-focus";

function windowHarness() {
	let shown = false;
	let onShow: (() => void) | null = null;
	const focus = vi.fn();
	const webFocus = vi.fn();
	return {
		window: {
			webContents: { focus: webFocus },
			isDestroyed: () => false,
			isVisible: () => shown,
			once: (_event: "show", listener: () => void) => {
				onShow = listener;
			},
			show: () => {
				shown = true;
			},
			focus,
		},
		show: () => {
			shown = true;
			onShow?.();
		},
		focus,
		webFocus,
	};
}

describe("focusTextEntry", () => {
	it("focuses after the preview window becomes visible when the field reported early", () => {
		const h = windowHarness();
		focusTextEntry(h.window, () => true);
		expect(h.focus).not.toHaveBeenCalled();
		expect(h.webFocus).not.toHaveBeenCalled();
		h.show();
		expect(h.focus).toHaveBeenCalledOnce();
		expect(h.webFocus).toHaveBeenCalledOnce();
	});

	it("does not focus after the field gives up focus while the window is hidden", () => {
		const h = windowHarness();
		let typing = true;
		focusTextEntry(h.window, () => typing);
		typing = false;
		h.show();
		expect(h.focus).not.toHaveBeenCalled();
		expect(h.webFocus).not.toHaveBeenCalled();
	});
});
