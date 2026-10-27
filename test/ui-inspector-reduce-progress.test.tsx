// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Inspector } from "../src/renderer/src/components/Inspector";
import type { FinderEntry } from "../src/renderer/src/data/entries";
import { NO_CAPABILITIES, type ActionCapabilities } from "../src/shared/actions-contract";
import { setAppLanguage } from "../src/shared/i18n";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	void setAppLanguage("ko");
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

const PDF_CAPS: ActionCapabilities = {
	...NO_CAPABILITIES,
	archive: true,
	reducibleExtensions: ["pdf"],
};

const SCAN: FinderEntry = {
	name: "scan.pdf",
	path: "/tmp/scan.pdf",
	kind: "file",
	ext: "pdf",
	size: 2_097_152,
	mtimeMs: 1_700_000_000_000,
	birthtimeMs: 0,
};

const noop = (): void => {};

describe("Inspector Reduce Size progress", () => {
	it("shows a progress bar, percentage, and working cancel button while reducing", () => {
		const onCancel = vi.fn();
		act(() =>
			root.render(
				<Inspector
					entry={SCAN}
					entries={[SCAN]}
					indexStatus={null}
					onToggleIndex={noop}
					onTrash={noop}
					onCopyPath={noop}
					onAskAi={noop}
					actionCapabilities={PDF_CAPS}
					onAction={noop}
					loadOpenWithApplications={async () => []}
					runningReduction={{ path: SCAN.path, name: SCAN.name, percent: 42 }}
					onCancelReduction={onCancel}
					family={null}
					onOpenMember={noop}
					view="info"
					evidence={[]}
					evidenceSelected={0}
					onSelectEvidence={noop}
					onRevealPath={noop}
					onToast={noop}
					imageActions={{ onOpenImage: noop, onOpenUrl: noop }}
				/>,
			),
		);

		const bar = host.querySelector('[role="progressbar"]');
		expect(bar).not.toBeNull();
		expect(bar?.getAttribute("aria-valuenow")).toBe("42");
		expect(host.textContent).toContain("42%");
		const reduceButton = host.querySelector<HTMLButtonElement>('button[data-action="reduceSize"]');
		expect(reduceButton?.disabled).toBe(true);
		const cancel = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
			(button.textContent ?? "").includes("취소"),
		);
		expect(cancel).toBeDefined();
		act(() => cancel?.click());
		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});
