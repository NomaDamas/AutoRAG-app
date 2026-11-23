// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FullDiskAccessDialog } from "../src/renderer/src/components/primitives/FullDiskAccessDialog";
import { setAppLanguage } from "../src/shared/i18n";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
	await setAppLanguage("ko");
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

describe("FullDiskAccessDialog", () => {
	it("shows one primary button that opens System Settings while ungranted and confirms once granted", async () => {
		let fullDiskAccess = false;
		const openFullDiskAccess = vi.fn(async () => undefined);
		const onConfirmed = vi.fn();
		const onClose = vi.fn();
		Reflect.set(window, "autorag", {
			onboarding: {
				permissions: async () => ({ platform: "darwin", fullDiskAccess }),
				openFullDiskAccess,
			},
		});

		await act(async () => {
			root.render(<FullDiskAccessDialog reason="tagColors" onClose={onClose} onConfirmed={onConfirmed} />);
		});

		const primaryButtons = () => host.querySelectorAll('[data-action="open-fda"], [data-action="confirm-fda"]');
		expect(primaryButtons()).toHaveLength(1);
		expect(primaryButtons()[0]?.getAttribute("data-action")).toBe("open-fda");

		await act(async () => {
			(primaryButtons()[0] as HTMLButtonElement).click();
		});
		expect(openFullDiskAccess).toHaveBeenCalledTimes(1);
		expect(onConfirmed).not.toHaveBeenCalled();

		fullDiskAccess = true;
		await act(async () => {
			window.dispatchEvent(new Event("focus"));
		});

		expect(primaryButtons()).toHaveLength(1);
		expect(primaryButtons()[0]?.getAttribute("data-action")).toBe("confirm-fda");

		await act(async () => {
			(primaryButtons()[0] as HTMLButtonElement).click();
		});
		expect(onConfirmed).toHaveBeenCalledTimes(1);
	});
});
