// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toast } from "../src/renderer/src/components/primitives/Toast";

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

describe("Toast", () => {
	it("is a polite live region with just the message by default", () => {
		act(() => root.render(<Toast message="경로를 복사했어요" />));
		const toast = host.querySelector("output");
		expect(toast?.getAttribute("aria-live")).toBe("polite");
		expect(toast?.textContent).toBe("경로를 복사했어요");
		expect(host.querySelector("button")).toBeNull();
	});

	it("offers one action beside the message, and running it calls back once", () => {
		const onAction = vi.fn();
		act(() => root.render(<Toast message="규칙을 삭제했어요" action={{ label: "실행 취소", onAction }} />));
		const button = host.querySelector("button");
		expect(button?.textContent).toBe("실행 취소");
		act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(onAction).toHaveBeenCalledTimes(1);
	});
});
