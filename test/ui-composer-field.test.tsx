// @vitest-environment happy-dom
import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPOSER_MAX_ROWS, ComposerField, composerFit } from "../src/renderer/src/components/ComposerField";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

describe("composerFit", () => {
	it("keeps one row for an empty or one-line draft", () => {
		expect(composerFit({ contentHeight: 0, rowHeight: 21, maxRows: 8 })).toEqual({ height: 21, scrolls: false });
		expect(composerFit({ contentHeight: 21, rowHeight: 21, maxRows: 8 })).toEqual({ height: 21, scrolls: false });
	});

	it("grows with the wrapped content", () => {
		expect(composerFit({ contentHeight: 63, rowHeight: 21, maxRows: 8 })).toEqual({ height: 63, scrolls: false });
	});

	it("stops growing at the row cap and scrolls beyond it", () => {
		expect(composerFit({ contentHeight: 168, rowHeight: 21, maxRows: 8 })).toEqual({ height: 168, scrolls: false });
		expect(composerFit({ contentHeight: 169, rowHeight: 21, maxRows: 8 })).toEqual({ height: 168, scrolls: true });
		expect(composerFit({ contentHeight: 4000, rowHeight: 21, maxRows: 8 })).toEqual({ height: 168, scrolls: true });
	});
});

let host: HTMLDivElement;
let root: Root;
let submitted: number;
let altEnters: number;
let contentHeight: number;

/** happy-dom does no layout: stand in for the browser's wrapped content height and line height. */
function stubLayout(): void {
	Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", { configurable: true, get: () => contentHeight });
	vi.spyOn(window, "getComputedStyle").mockImplementation(() => ({ lineHeight: "21px", fontSize: "14px" }) as CSSStyleDeclaration);
}

function Harness({ initial }: { readonly initial: string }): ReactElement {
	const [value, setValue] = useState(initial);
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				submitted += 1;
			}}
		>
			<ComposerField
				value={value}
				onChange={setValue}
				onAltEnter={() => {
					altEnters += 1;
				}}
				placeholder="Ask"
				ariaLabel="Ask Dazzi"
			/>
		</form>
	);
}

async function mount(initial = ""): Promise<void> {
	await act(async () => root.render(<Harness initial={initial} />));
}

const field = (): HTMLTextAreaElement => host.querySelector<HTMLTextAreaElement>("textarea")!;

function press(init: KeyboardEventInit): KeyboardEvent {
	const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
	act(() => void field().dispatchEvent(event));
	return event;
}

beforeEach(() => {
	submitted = 0;
	altEnters = 0;
	contentHeight = 21;
	stubLayout();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.restoreAllMocks();
	Reflect.deleteProperty(HTMLTextAreaElement.prototype, "scrollHeight");
});

describe("ComposerField", () => {
	it("is a wrapping multi-line field, not a one-line input", async () => {
		await mount();
		expect(host.querySelector("input")).toBeNull();
		expect(field().getAttribute("aria-label")).toBe("Ask Dazzi");
		expect(field().getAttribute("placeholder")).toBe("Ask");
		expect(field().getAttribute("rows")).toBe("1");
	});

	it("sends on Enter through the enclosing form", async () => {
		await mount("hello");
		const event = press({ key: "Enter" });
		expect(event.defaultPrevented).toBe(true);
		expect(submitted).toBe(1);
		expect(altEnters).toBe(0);
	});

	it("keeps Shift+Enter as a newline", async () => {
		await mount("hello");
		const event = press({ key: "Enter", shiftKey: true });
		expect(event.defaultPrevented).toBe(false);
		expect(submitted).toBe(0);
		expect(altEnters).toBe(0);
	});

	it("sends nothing while an IME composition is confirmed with Enter", async () => {
		await mount("한글");
		const composing = press({ key: "Enter", isComposing: true });
		expect(composing.defaultPrevented).toBe(false);
		const legacy = press({ key: "Enter", keyCode: 229 });
		expect(legacy.defaultPrevented).toBe(false);
		expect(submitted).toBe(0);
	});

	it("queues on Alt+Enter without submitting", async () => {
		await mount("next question");
		const event = press({ key: "Enter", altKey: true });
		expect(event.defaultPrevented).toBe(true);
		expect(altEnters).toBe(1);
		expect(submitted).toBe(0);
	});

	it("grows to the wrapped height and hides the scrollbar while it fits", async () => {
		contentHeight = 63;
		await mount("a long question that wraps over three lines");
		expect(field().style.height).toBe("63px");
		expect(field().style.overflowY).toBe("hidden");
	});

	it("caps at the row limit and scrolls the rest", async () => {
		contentHeight = 600;
		await mount("x\n".repeat(60));
		expect(field().style.height).toBe(`${21 * COMPOSER_MAX_ROWS}px`);
		expect(field().style.overflowY).toBe("auto");
	});

	it("shrinks back when the draft is cleared", async () => {
		contentHeight = 600;
		await mount("x\n".repeat(60));
		contentHeight = 21;
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
			setter.call(field(), "");
			field().dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(field().style.height).toBe("21px");
		expect(field().style.overflowY).toBe("hidden");
	});
});
