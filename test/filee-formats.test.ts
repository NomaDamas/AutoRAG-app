import { describe, expect, it } from "vitest";
import { parseFormatTargets } from "../src/main/filee-formats";

const DOCX = `DOCX (docx) converts to:
  png, jpg, webp, pdf, txt
With engines filee-cli downloads when a conversion needs them ('filee engines list'):
  svg, eps, doc
`;

describe("parseFormatTargets", () => {
	it("reads the direct targets and the ones that need an engine download", () => {
		const targets = parseFormatTargets(DOCX);
		expect([...(targets ?? [])].sort()).toEqual(["doc", "eps", "jpg", "pdf", "png", "svg", "txt", "webp"]);
	});

	it("does not mistake the header lines for targets", () => {
		const targets = parseFormatTargets(DOCX);
		expect(targets?.has("docx")).toBe(false);
		expect(targets?.has("converts")).toBe(false);
	});

	it("reads CRLF output", () => {
		expect(parseFormatTargets(DOCX.replaceAll("\n", "\r\n"))?.has("svg")).toBe(true);
	});

	it("returns null for text without target lines, so an unknown layout never reads as 'supports nothing'", () => {
		expect(parseFormatTargets("")).toBeNull();
		expect(parseFormatTargets("DOCX (docx) converts to:\n")).toBeNull();
	});
});
