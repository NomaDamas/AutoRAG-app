// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PathBar } from "../src/renderer/src/components/PathBar";
import { breadcrumbTrail } from "../src/renderer/src/state/paths";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// /Users/jeffrey/Desktop/Work/2025-2/bx → Macintosh HD › Users › jeffrey › Desktop › Work › 2025-2 › bx
const PATH = "/Users/jeffrey/Desktop/Work/2025-2/bx";

let host: HTMLDivElement;
let root: Root;
let viewportWidth = 10_000;

/** happy-dom lays nothing out: every measured segment is 60px, "…" and a separator 10px, the viewport `viewportWidth`. */
function fakeBox(this: Element): DOMRect {
	const element = this as HTMLElement;
	let width = 0;
	if (element.matches("[data-measure-segment]")) width = 60;
	else if (element.matches("[data-measure-more], [data-measure-separator]")) width = 10;
	else if (element.matches(".path-label")) width = 30;
	else if (element.parentElement?.matches("nav.pathbar") === true && element.className.includes("flex-1")) width = viewportWidth;
	return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: 20, width, height: 20, toJSON: () => ({}) } as DOMRect;
}

beforeEach(() => {
	vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(fakeBox);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.restoreAllMocks();
	viewportWidth = 10_000;
});

function render(onNavigate: (path: string) => void = () => {}): void {
	act(() =>
		root.render(
			<PathBar
				path={PATH}
				crumbs={breadcrumbTrail(PATH, Number.MAX_SAFE_INTEGER)}
				selectedName={null}
				onNavigate={onNavigate}
				onGoToPath={() => Promise.resolve(true)}
				completePath={() => Promise.resolve([])}
				openEditor={0}
				onEditorClosed={() => {}}
			/>,
		),
	);
}

const shown = (): string[] => [...host.querySelectorAll<HTMLElement>("nav.pathbar .path-trail .path-name")].map((name) => name.textContent ?? "");
const more = (): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>("nav.pathbar .path-trail [data-path-more]");
const menuItems = (): string[] => [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].map((item) => item.textContent ?? "");

describe("PathBar overflow", () => {
	it("shows every folder and no “…” when the trail fits", () => {
		render();
		expect(shown()).toEqual(["Macintosh HD", "Users", "jeffrey", "Desktop", "Work", "2025-2", "bx"]);
		expect(more()).toBeNull();
	});

	it("keeps the root and the last folders in full and folds the middle into “…”", () => {
		// 7 segments × 60 + separators: root, …, 2025-2, bx fit in 230px.
		viewportWidth = 230;
		render();
		expect(shown()).toEqual(["Macintosh HD", "2025-2", "bx"]);
		expect(more()).not.toBeNull();
		// No separator between "…" and the folder after it.
		const trail = host.querySelector("nav.pathbar .path-trail")!;
		expect(trail.textContent).toBe("Macintosh HD›2025-2›bx");
	});

	it("lists the folded folders in path order and navigates from the dropdown", () => {
		viewportWidth = 230;
		const onNavigate = vi.fn();
		render(onNavigate);
		act(() => more()!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(more()!.getAttribute("aria-expanded")).toBe("true");
		expect(menuItems()).toEqual(["Users", "jeffrey", "Desktop", "Work"]);
		// Opening the menu never opens the path editor underneath it.
		expect(host.querySelector("nav.pathbar input")).toBeNull();
		const work = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === "Work")!;
		act(() => work.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(onNavigate).toHaveBeenCalledWith("/Users/jeffrey/Desktop/Work");
		expect(document.querySelector('[role="menu"]')).toBeNull();
	});

	it("closes the dropdown on Escape and keeps the key from the Finder keymap", () => {
		viewportWidth = 230;
		render();
		act(() => more()!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		const behind = vi.fn();
		window.addEventListener("keydown", behind);
		const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		act(() => {
			document.activeElement?.dispatchEvent(event);
		});
		window.removeEventListener("keydown", behind);
		expect(document.querySelector('[role="menu"]')).toBeNull();
		expect(event.defaultPrevented).toBe(true);
		expect(behind).not.toHaveBeenCalled();
	});

	it("folds the root too, but never the current folder", () => {
		viewportWidth = 100;
		render();
		expect(shown()).toEqual(["bx"]);
		act(() => more()!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(menuItems()).toEqual(["Macintosh HD", "Users", "jeffrey", "Desktop", "Work", "2025-2"]);
	});
});
