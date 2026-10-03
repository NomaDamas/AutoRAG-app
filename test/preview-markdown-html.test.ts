// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { previewStreamUrl } from "../src/preview/shared/contract";
import { resolveRelative } from "../src/preview/shared/location";
import { sanitizeMarkdownHtml } from "../src/preview/ui/markdown-html";

const DIR = "/Users/me/project";

describe("markdown html sanitizing", () => {
	it("drops scripts, handlers, and active embeds", () => {
		const html = sanitizeMarkdownHtml(
			'<p onclick="steal()">hi<script>alert(1)</script></p><iframe title="embed"></iframe><img src="a.png" onerror="steal()"><style>body{}</style>',
			DIR,
		);
		expect(html).not.toContain("script");
		expect(html).not.toContain("onclick");
		expect(html).not.toContain("onerror");
		expect(html).not.toContain("iframe");
		expect(html).not.toContain("style");
		expect(html).toContain("<p>hi</p>");
	});

	it("keeps safe links and strips script urls", () => {
		const html = sanitizeMarkdownHtml('<a href="https://example.com" title="t">ok</a><a href="javascript:alert(1)">bad</a><a href="#part">jump</a>', DIR);
		expect(html).toContain('<a href="https://example.com" title="t">ok</a>');
		expect(html).toContain("<a>bad</a>");
		expect(html).toContain('<a href="#part">jump</a>');
	});

	it("serves relative images through the preview protocol and drops remote ones", () => {
		const html = sanitizeMarkdownHtml('<img src="docs/shot%201.png" alt="shot"><img src="https://tracker.example/p.gif" alt="remote">', DIR);
		const local = previewStreamUrl("/Users/me/project/docs/shot 1.png").replace(/&/g, "&amp;");
		expect(html).toContain(`<img src="${local}" alt="shot">`);
		expect(html).toContain('<img alt="remote">');
	});

	it("unwraps unknown elements but keeps their text", () => {
		expect(sanitizeMarkdownHtml('<custom-box><b>bold</b> text</custom-box><details><summary>more</summary>body</details>', DIR)).toBe(
			"<b>bold</b> text<details><summary>more</summary>body</details>",
		);
	});

	it("keeps disabled task-list checkboxes only", () => {
		const html = sanitizeMarkdownHtml('<li><input type="checkbox" checked="" disabled=""> done</li><input type="text" value="x">', DIR);
		expect(html).toContain('<input type="checkbox" checked="" disabled="">');
		expect(html).not.toContain('type="text"');
	});
});

describe("relative paths", () => {
	it("resolves against the document's folder on either platform", () => {
		expect(resolveRelative("/a/b", "c/d.png")).toBe("/a/b/c/d.png");
		expect(resolveRelative("/a/b", "./../c.png")).toBe("/a/c.png");
		expect(resolveRelative("C:\\docs\\site", "img\\logo.png")).toBe("C:\\docs\\site\\img\\logo.png");
		expect(resolveRelative("C:\\docs\\site", "../logo.png?v=2#top")).toBe("C:\\docs\\logo.png");
	});

	it("refuses absolute and remote references", () => {
		expect(resolveRelative("/a/b", "/etc/passwd")).toBeNull();
		expect(resolveRelative("/a/b", "https://x/y.png")).toBeNull();
		expect(resolveRelative("/a/b", "data:image/png;base64,AAAA")).toBeNull();
		expect(resolveRelative("/a", "../../../x.png")).toBeNull();
	});
});
