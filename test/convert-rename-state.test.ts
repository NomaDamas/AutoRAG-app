import { describe, expect, it } from "vitest";
import { conversionErrorMessage } from "../src/renderer/src/state/convert-rename";

describe("conversionErrorMessage", () => {
	it("shows only the message of an error Electron wrapped for the IPC boundary", () => {
		const wrapped = new Error("Error invoking remote method 'conversion:run': Error: Conversion of a.mp4 was cancelled.");
		expect(conversionErrorMessage(wrapped)).toBe("Conversion of a.mp4 was cancelled.");
	});

	it("leaves an unwrapped message alone", () => {
		expect(conversionErrorMessage(new Error("Could not convert a.mp4: boom"))).toBe("Could not convert a.mp4: boom");
		expect(conversionErrorMessage("plain")).toBe("plain");
	});
});
