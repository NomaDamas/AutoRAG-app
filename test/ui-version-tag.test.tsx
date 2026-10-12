// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VersionTag } from "../src/renderer/src/components/FileRow";
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

function labels(): string[] {
	return [...host.querySelectorAll(".vtag")].map((tag) => tag.textContent ?? "");
}

describe("VersionTag", () => {
	it("labels the family badges in the Interface language and follows a language change", async () => {
		await act(() => setAppLanguage("en"));
		act(() =>
			root.render(
				<>
					<VersionTag tone="latest" />
					<VersionTag tone="near" />
					<VersionTag tone="exact" />
				</>,
			),
		);
		expect(labels()).toEqual(["Latest", "Similar", "Exact"]);

		await act(() => setAppLanguage("ja"));
		expect(labels()).not.toContain("최신본");
		expect(labels()).not.toContain("Latest");

		await act(() => setAppLanguage("ko"));
		expect(labels()).toEqual(["최신본", "유사본", "동일본"]);
	});
});
