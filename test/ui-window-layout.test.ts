import { describe, expect, it } from "vitest";
import { windowColumns } from "../src/renderer/src/state/window-layout";

const BASE = { sidebarVisible: true, sidebarWidth: 240, inspectorVisible: true, inspectorWidth: 320, settingsOpen: false };

describe("windowColumns", () => {
	it("lays out left sidebar, content, right sidebar", () => {
		expect(windowColumns(BASE)).toBe("240px minmax(0,1fr) 320px");
	});

	it("collapses a hidden sidebar to zero", () => {
		expect(windowColumns({ ...BASE, sidebarVisible: false, inspectorVisible: false })).toBe("0px minmax(0,1fr) 0px");
	});

	it("keeps the left column for Settings' own sidebar even when the Finder sidebar is hidden", () => {
		expect(windowColumns({ ...BASE, sidebarVisible: false, settingsOpen: true })).toBe("240px minmax(0,1fr) 320px");
	});

	it("leaves the right sidebar to its own visibility while Settings is open", () => {
		expect(windowColumns({ ...BASE, inspectorVisible: false, settingsOpen: true })).toBe("240px minmax(0,1fr) 0px");
	});
});
