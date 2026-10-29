// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IndexNoticeBanner } from "../src/renderer/src/components/IndexNotice";
import { setAppLanguage, SUPPORTED_LANGUAGES, t } from "../src/shared/i18n";
import type { IndexNotice } from "../src/shared/search-contract";

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

const buttons = (): HTMLButtonElement[] => [...host.querySelectorAll("button")];
const REASONS: readonly IndexNotice["reason"][] = ["indexing", "failed", "empty", "few"];
const notice = (reason: IndexNotice["reason"]): IndexNotice => ({ reason, documents: reason === "empty" ? 0 : 3 });

describe("IndexNoticeBanner", () => {
	it("says why the search may fall short, in words that differ by reason", () => {
		const texts = REASONS.map((reason) => {
			act(() => root.render(<IndexNoticeBanner notice={notice(reason)} onOpenIndexing={vi.fn()} />));
			return host.querySelector('[role="status"]')?.textContent ?? "";
		});

		expect(texts.every((text) => text.length > 0)).toBe(true);
		expect(new Set(texts).size).toBe(REASONS.length);
	});

	it("puts the number of indexed documents into the small-index message", () => {
		act(() => root.render(<IndexNoticeBanner notice={{ reason: "few", documents: 7 }} onOpenIndexing={vi.fn()} />));

		expect(host.textContent).toContain("7");
	});

	it("offers one button, named for the Settings page it opens, and calls back when it is pressed", () => {
		const onOpenIndexing = vi.fn();
		act(() => root.render(<IndexNoticeBanner notice={notice("indexing")} onOpenIndexing={onOpenIndexing} />));

		expect(buttons()).toHaveLength(1);
		expect(buttons()[0]?.textContent).toBe(t("aiSearch.indexNotice.manage"));
		expect(t("aiSearch.indexNotice.manage")).toContain(t("settingsCore.nav.indexing"));

		act(() => buttons()[0]?.click());

		expect(onOpenIndexing).toHaveBeenCalledTimes(1);
	});

	it("reads in every interface language, with the count and the page name in place", async () => {
		for (const language of SUPPORTED_LANGUAGES) {
			await act(async () => {
				await setAppLanguage(language);
			});
			act(() => root.render(<IndexNoticeBanner notice={{ reason: "few", documents: 7 }} onOpenIndexing={vi.fn()} />));

			expect(host.textContent, language).toContain("7");
			expect(host.textContent, language).not.toMatch(/\{\{|aiSearch\./u);
			expect(buttons()[0]?.textContent?.toLowerCase(), language).toContain(t("settingsCore.nav.indexing").toLowerCase());
		}
	});
});
