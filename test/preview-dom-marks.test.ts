// @vitest-environment happy-dom
import { marked } from "marked";
import { describe, expect, it } from "vitest";
import { locateDomRanges } from "../src/preview/ui/dom-marks";
import { sanitizeMarkdownHtml } from "../src/preview/ui/markdown-html";

function render(markdown: string): HTMLElement {
	const article = document.createElement("article");
	article.innerHTML = sanitizeMarkdownHtml(marked.parse(markdown, { async: false, gfm: true }) as string, null);
	document.body.append(article);
	return article;
}

describe("locateDomRanges", () => {
	it("finds a raw Markdown excerpt in the rendered text across emphasis and inline code", () => {
		const article = render("# Policy\n\nRefunds need **written approval** from `two` directors.\n\nUnrelated closing paragraph about holidays.");
		const ranges = locateDomRanges(article, ["Refunds need **written approval** from `two` directors."]);
		expect(ranges.map((range) => range.toString()).join("")).toBe("Refunds need written approval from two directors");
	});

	it("finds a chunk cut from a pipe table inside the rendered cells", () => {
		const article = render("| Plan | Seats |\n| --- | --- |\n| Team | 30 users |\n| Pro | 5 users |\n\nTrailing note.");
		const ranges = locateDomRanges(article, ["| Team | 30 users |"]);
		const painted = ranges.map((range) => range.toString()).join("|");
		expect(painted).toContain("Team");
		expect(painted).toContain("30 users");
		expect(painted).not.toContain("Pro");
	});

	it("tries the excerpts in order and skips one the page does not contain", () => {
		const article = render("The reimbursement window closes thirty days after the invoice date.");
		const ranges = locateDomRanges(article, ["Completely unrelated sentence about parking spaces and elevators.", "reimbursement window closes thirty days after the invoice date"]);
		expect(ranges.map((range) => range.toString()).join("")).toContain("reimbursement window closes thirty days");
	});

	it("returns nothing when no excerpt is on the page", () => {
		const article = render("Only this paragraph exists in the document.");
		expect(locateDomRanges(article, ["A passage that was never written anywhere near here."])).toEqual([]);
	});
});
