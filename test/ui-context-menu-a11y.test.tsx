// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextMenu } from "../src/renderer/src/components/primitives/ContextMenu";
import type { FinderMenuEntry } from "../src/renderer/src/state/context-menu";

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

/** The accessible name a screen reader (and Playwright's getByRole) computes: aria-hidden subtrees are skipped. */
function accessibleName(element: Element): string {
	let name = "";
	for (const node of element.childNodes) {
		if (node.nodeType === Node.TEXT_NODE) name += node.textContent ?? "";
		else if (node instanceof Element && node.getAttribute("aria-hidden") !== "true") name += accessibleName(node);
	}
	return name;
}

describe("ContextMenu", () => {
	it("keeps the shortcut keycap visible but out of the item's accessible name", () => {
		const entries: FinderMenuEntry[] = [
			{ kind: "item", action: "rename", label: "Rename", keycap: "⌘R", tone: "default", disabled: false },
			{ kind: "item", action: "copyPath", label: "Copy Path", keycap: null, tone: "default", disabled: false },
		];
		act(() => root.render(<ContextMenu cursor={{ x: 0, y: 0 }} entries={entries} onSelect={() => {}} onClose={() => {}} />));
		const items = [...host.querySelectorAll('[role="menuitem"]')];
		expect(items.map(accessibleName)).toEqual(["Rename", "Copy Path"]);
		expect(host.querySelector(".menu__keycap")?.textContent).toBe("⌘R");
	});
});
