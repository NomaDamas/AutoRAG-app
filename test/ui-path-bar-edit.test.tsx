// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PathBar } from "../src/renderer/src/components/PathBar";
import { breadcrumbTrail } from "../src/renderer/src/state/paths";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const PATH = "/Users/jeffrey/Documents/Finance";

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

function render(props: { path?: string; onNavigate?: (path: string) => void; onGoToPath?: (input: string) => Promise<boolean> }): void {
	const path = props.path ?? PATH;
	act(() =>
		root.render(
			<PathBar
				path={path}
				crumbs={breadcrumbTrail(path, Number.MAX_SAFE_INTEGER)}
				selectedName={null}
				onNavigate={props.onNavigate ?? (() => {})}
				onGoToPath={props.onGoToPath ?? (() => Promise.resolve(true))}
			/>,
		),
	);
}

const nav = (): HTMLElement => host.querySelector<HTMLElement>("nav.pathbar")!;
const editor = (): HTMLInputElement | null => host.querySelector<HTMLInputElement>("nav.pathbar input");
const segment = (label: string): HTMLButtonElement =>
	[...host.querySelectorAll<HTMLButtonElement>(".path-seg")].find((button) => button.textContent === label)!;

function click(element: Element): void {
	act(() => {
		element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
}

function type(input: HTMLInputElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
	act(() => {
		setter.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function press(input: HTMLInputElement, key: string): Promise<KeyboardEvent> {
	const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
	await act(async () => {
		input.dispatchEvent(event);
	});
	return event;
}

describe("PathBar path editing", () => {
	it("navigates when a folder segment is clicked, without opening the editor", () => {
		const onNavigate = vi.fn();
		render({ onNavigate });
		click(segment("Documents"));
		expect(onNavigate).toHaveBeenCalledWith("/Users/jeffrey/Documents");
		expect(editor()).toBeNull();
	});

	it("opens an editor holding the full path, selected, when the empty bar is clicked", () => {
		render({});
		click(nav());
		const input = editor();
		expect(input).not.toBeNull();
		expect(input!.value).toBe(PATH);
		expect(document.activeElement).toBe(input);
		expect([input!.selectionStart, input!.selectionEnd]).toEqual([0, PATH.length]);
	});

	it("opens the editor from the gap between segments", () => {
		render({});
		click(host.querySelector(".path-sep")!);
		expect(editor()?.value).toBe(PATH);
	});

	it("opens the editor from a segment that is not a folder (the volume prefix)", () => {
		const onNavigate = vi.fn();
		render({ onNavigate });
		click(segment("Macintosh HD"));
		expect(onNavigate).not.toHaveBeenCalled();
		expect(editor()?.value).toBe(PATH);
	});

	it("submits the typed path on Enter and closes once the move succeeds", async () => {
		const onGoToPath = vi.fn(() => Promise.resolve(true));
		render({ onGoToPath });
		click(nav());
		type(editor()!, "/tmp/pasted");
		const event = await press(editor()!, "Enter");
		expect(onGoToPath).toHaveBeenCalledWith("/tmp/pasted");
		expect(event.defaultPrevented).toBe(true);
		expect(editor()).toBeNull();
	});

	it("keeps the editor open with the text selected when the path cannot be opened", async () => {
		render({ onGoToPath: () => Promise.resolve(false) });
		click(nav());
		type(editor()!, "/nope");
		await press(editor()!, "Enter");
		const input = editor();
		expect(input?.value).toBe("/nope");
		expect([input!.selectionStart, input!.selectionEnd]).toEqual([0, "/nope".length]);
	});

	it("cancels on Escape without submitting, and the Escape stays inside the editor", async () => {
		const onGoToPath = vi.fn(() => Promise.resolve(true));
		const outside = vi.fn();
		window.addEventListener("keydown", outside);
		try {
			render({ onGoToPath });
			click(nav());
			type(editor()!, "/elsewhere");
			await press(editor()!, "Escape");
		} finally {
			window.removeEventListener("keydown", outside);
		}
		expect(onGoToPath).not.toHaveBeenCalled();
		expect(outside).not.toHaveBeenCalled();
		expect(editor()).toBeNull();
		expect(segment("Finance")).toBeDefined();
	});

	it("cancels when the editor loses focus", () => {
		const onGoToPath = vi.fn(() => Promise.resolve(true));
		render({ onGoToPath });
		click(nav());
		act(() => editor()!.blur());
		expect(onGoToPath).not.toHaveBeenCalled();
		expect(editor()).toBeNull();
	});

	it("closes the editor when the folder in view changes underneath it", () => {
		render({});
		click(nav());
		render({ path: "/Users/jeffrey/Desktop" });
		expect(editor()).toBeNull();
	});
});
