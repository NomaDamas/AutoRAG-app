// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VersionFamilyBanner } from "../src/renderer/src/components/VersionFamilyBanner";
import type { VersionFamilyError } from "../src/renderer/src/state/version-family";
import { setAppLanguage } from "../src/shared/i18n";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	act(() => root.unmount());
	host.remove();
	await setAppLanguage("ko");
});

function show(error: VersionFamilyError | null): void {
	act(() => root.render(<VersionFamilyBanner error={error} onRetry={() => undefined} />));
}

const timedOut: VersionFamilyError = {
	code: "scan-failed",
	message: "dupey timed out.",
	installCommand: null,
	scan: { name: "Desktop", reason: "timeout" },
};

describe("VersionFamilyBanner", () => {
	it("words a folder's timeout around that folder, in the Interface language", async () => {
		await act(() => setAppLanguage("en"));
		show(timedOut);
		const text = host.querySelector(".list__error-text")?.textContent ?? "";
		expect(text).toContain('"Desktop"');
		expect(text).toContain("took too long");
		expect(text).toContain("other folders is unaffected");
		// A scoped failure is not dupey's raw message, and it still offers a retry.
		expect(text).not.toContain("dupey");
		expect(host.querySelector(".list__error-retry")?.textContent).toBe("Check again");

		await act(() => setAppLanguage("ko"));
		expect(host.querySelector(".list__error-text")?.textContent).toContain("다른 폴더의 버전 묶기는 그대로입니다");
	});

	it("adds dupey's own message to a folder's scan error", async () => {
		await act(() => setAppLanguage("en"));
		show({ ...timedOut, message: "dupey failed with exit code 1: boom", scan: { name: "Docs", reason: "error" } });
		const text = host.querySelector(".list__error-text")?.textContent ?? "";
		expect(text).toContain('"Docs"');
		expect(text).toContain("dupey failed with exit code 1: boom");
	});

	it("shows a feature-wide error as it came, with the install command", () => {
		show({ code: "dupey-missing", message: "dupey CLI is required", installCommand: "cargo install dupey" });
		expect(host.querySelector(".list__error-text")?.textContent).toBe("dupey CLI is required");
		expect(host.querySelector(".list__error-command")?.textContent).toBe("cargo install dupey");
	});

	it("renders nothing without an error", () => {
		show(null);
		expect(host.querySelector('[role="alert"]')).toBeNull();
	});
});
