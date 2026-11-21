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

describe("VersionFamilyBanner", () => {
	it("explains a folder timeout in the interface language", async () => {
		await act(() => setAppLanguage("en"));
		show({
			code: "scan-failed",
			message: "dupey timed out.",
			installCommand: null,
			scan: { name: "Desktop", reason: "timeout" },
		});
		const text = host.querySelector(".list__error-text")?.textContent ?? "";
		expect(text).toContain('"Desktop"');
		expect(text).toContain("took too long");
		expect(text).not.toContain("dupey timed out");
		expect(host.querySelector("button")?.textContent).toBe("Check again");
	});

	it("includes the raw message for a folder scan error", async () => {
		await act(() => setAppLanguage("en"));
		show({
			code: "scan-failed",
			message: "dupey failed with exit code 1: boom",
			installCommand: null,
			scan: { name: "Docs", reason: "error" },
		});
		const text = host.querySelector(".list__error-text")?.textContent ?? "";
		expect(text).toContain('"Docs"');
		expect(text).toContain("dupey failed with exit code 1: boom");
	});

	it("keeps feature-wide errors and install commands unchanged", () => {
		show({ code: "dupey-missing", message: "dupey CLI is required", installCommand: "cargo install dupey" });
		expect(host.querySelector(".list__error-text")?.textContent).toBe("dupey CLI is required");
		expect(host.querySelector(".list__error-command")?.textContent).toBe("cargo install dupey");
	});

	it("renders nothing without an error", () => {
		show(null);
		expect(host.querySelector('[role="alert"]')).toBeNull();
	});
});
