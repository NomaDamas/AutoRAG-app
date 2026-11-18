// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Inspector } from "../src/renderer/src/components/Inspector";
import { NO_CAPABILITIES } from "../src/shared/actions-contract";
import { setAppLanguage } from "../src/shared/i18n";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const noop = (): void => {};
const evidence = [1, 2].map((number) => ({ number, title: `${number}.md`, summary: "", source: `/work/${number}.md`, excerpts: [`발췌 ${number}`] }));

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

function render(selected: number, freshEvidence?: readonly number[]): void {
	act(() =>
		root.render(
			<Inspector
				entry={null}
				entries={[]}
				indexStatus={null}
				onToggleIndex={noop}
				onTrash={noop}
				onCopyPath={noop}
				onAskAi={noop}
				actionCapabilities={NO_CAPABILITIES}
				onAction={noop}
				loadOpenWithApplications={async () => []}
				family={null}
				onOpenMember={noop}
				view="evidence"
				evidence={evidence}
				{...(freshEvidence === undefined ? {} : { freshEvidence })}
				evidenceSelected={selected}
				onSelectEvidence={noop}
				onRevealPath={noop}
				onToast={noop}
				imageActions={{ onOpenImage: noop, onOpenUrl: noop }}
			/>,
		),
	);
}

const tab = (number: number): HTMLElement => host.querySelector(`.evidence-tab:nth-child(${number})`) as HTMLElement;

describe("the inspector's tab of a source a correction brought in", () => {
	it("carries a dot and a name that says it is new, until that source is the one being read", () => {
		render(1, [2]);
		expect(tab(2).getAttribute("data-fresh")).toBe("true");
		expect(tab(2).querySelector(".evidence-tab-dot")).not.toBeNull();
		expect(tab(2).getAttribute("aria-label")).toBe("2번 새 출처");
		// The other tab is as it always was.
		expect(tab(1).getAttribute("data-fresh")).toBeNull();
		expect(tab(1).querySelector(".evidence-tab-dot")).toBeNull();
		// Opening it ends the news: the selected tab is drawn as selected, with no dot.
		render(2, [2]);
		expect(tab(2).getAttribute("data-fresh")).toBeNull();
		expect(tab(2).querySelector(".evidence-tab-dot")).toBeNull();
	});

	it("is not marked when no correction brought in a source", () => {
		render(1);
		expect(host.querySelector("[data-fresh]")).toBeNull();
	});
});
