// @vitest-environment happy-dom
import { act, createRef, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { useFinderKeyboard, type FinderKeyboardInput } from "../src/renderer/src/hooks/useFinderKeyboard";
import { EMPTY_SELECTION } from "../src/renderer/src/state/selection";

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

function actions(open: boolean): { readonly input: FinderKeyboardInput["actions"]; readonly quickLookSelection: Mock; readonly closeOpenQuickLook: Mock } {
	const quickLookSelection = vi.fn();
	const closeOpenQuickLook = vi.fn(() => open);
	const noop = vi.fn();
	const input = new Proxy({ quickLookSelection, closeOpenQuickLook } as Record<string, unknown>, { get: (target, name: string) => target[name] ?? noop }) as unknown as FinderKeyboardInput["actions"];
	return { input, quickLookSelection, closeOpenQuickLook };
}

function Harness({ path, input }: { readonly path: string; readonly input: FinderKeyboardInput["actions"] }): ReactElement {
	useFinderKeyboard({
		focused: true,
		zone: "finder",
		path,
		layout: "list",
		selection: EMPTY_SELECTION,
		orderedKeys: [],
		stackRows: [],
		stackSections: [],
		focusedEntry: null,
		listRef: createRef<HTMLDivElement>(),
		actions: input,
	});
	return (
		<>
			<button type="button" id="evidence-title">
				1. evidence title
			</button>
			<input id="composer" />
		</>
	);
}

function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
	const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
	act(() => void target.dispatchEvent(event));
	return event;
}

describe("Space with a preview open", () => {
	it("closes it from a focused button (the evidence title that opened it) on an AI Search tab", () => {
		const { input, quickLookSelection, closeOpenQuickLook } = actions(true);
		act(() => root.render(<Harness path="AI Search" input={input} />));
		const title = host.querySelector<HTMLElement>("#evidence-title")!;
		title.focus();
		const event = press(title, " ");
		expect(closeOpenQuickLook).toHaveBeenCalledTimes(1);
		expect(event.defaultPrevented).toBe(true);
		expect(quickLookSelection).not.toHaveBeenCalled();
	});

	it("leaves a focused button alone when no preview is open, so Space still presses it", () => {
		const { input, closeOpenQuickLook } = actions(false);
		act(() => root.render(<Harness path="AI Search" input={input} />));
		const title = host.querySelector<HTMLElement>("#evidence-title")!;
		title.focus();
		const event = press(title, " ");
		expect(closeOpenQuickLook).toHaveBeenCalledTimes(1);
		expect(event.defaultPrevented).toBe(false);
	});

	it("never closes it while the user is typing a space into a field", () => {
		const { input, closeOpenQuickLook } = actions(true);
		act(() => root.render(<Harness path="AI Search" input={input} />));
		const composer = host.querySelector<HTMLElement>("#composer")!;
		composer.focus();
		const event = press(composer, " ");
		expect(closeOpenQuickLook).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	it("does not treat a modified Space as the close key", () => {
		const { input, closeOpenQuickLook } = actions(true);
		act(() => root.render(<Harness path="/Users/me" input={input} />));
		const title = host.querySelector<HTMLElement>("#evidence-title")!;
		press(title, " ", { shiftKey: true });
		press(title, " ", { metaKey: true });
		expect(closeOpenQuickLook).not.toHaveBeenCalled();
	});
});
