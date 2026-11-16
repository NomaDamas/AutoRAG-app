// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { emphasizeTerms } from "../src/renderer/src/lib/mark-terms";

const html = (name: string, query: string): string => renderToStaticMarkup(<span>{emphasizeTerms(name, query)}</span>);

describe("emphasizeTerms (search result names, Figma 428:1845)", () => {
	it("puts every match of the query in bold, wherever it is in the name", () => {
		expect(html("2026-공급계약서.pdf", "계약서")).toBe('<span>2026-공급<strong class="font-bold">계약서</strong>.pdf</span>');
		expect(html("협력사_계약서_서명본.pdf", "계약서")).toBe('<span>협력사_<strong class="font-bold">계약서</strong>_서명본.pdf</span>');
	});

	it("matches each word of the query, ignoring case, and one-character words too", () => {
		expect(html("Budget 2026 v3.xlsx", "budget v")).toBe('<span><strong class="font-bold">Budget</strong> 2026 <strong class="font-bold">v</strong>3.xlsx</span>');
	});

	it("leaves the name alone when nothing matches or the query is empty, and treats regex characters as text", () => {
		expect(html("회의록.md", "계약서")).toBe("<span>회의록.md</span>");
		expect(html("회의록.md", "  ")).toBe("<span>회의록.md</span>");
		expect(html("a+b (final).txt", "(final)")).toBe('<span>a+b <strong class="font-bold">(final)</strong>.txt</span>');
	});
});
