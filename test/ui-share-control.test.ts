import { describe, expect, it } from "vitest";
import { NO_CAPABILITIES, type ActionCapabilities } from "../src/shared/actions-contract";
import { toolbarShareControl } from "../src/renderer/src/state/file-actions";

/** A macOS probe: open-with and a share sheet, no image/video engines needed here. */
const MAC: ActionCapabilities = {
	openWith: true,
	share: true,
	archive: true,
	imageFormats: [],
	videoContainers: [],
};

describe("toolbarShareControl", () => {
	it("shows and enables Share where the OS has a share sheet and a row is focused", () => {
		expect(toolbarShareControl(true, MAC)).toEqual({ shown: true, enabled: true });
	});

	it("shows Share disabled while nothing is focused", () => {
		expect(toolbarShareControl(false, MAC)).toEqual({ shown: true, enabled: false });
	});

	it("hides Share entirely where the OS has no share sheet", () => {
		expect(toolbarShareControl(true, NO_CAPABILITIES)).toEqual({ shown: false, enabled: false });
		expect(toolbarShareControl(false, NO_CAPABILITIES)).toEqual({ shown: false, enabled: false });
	});
});
