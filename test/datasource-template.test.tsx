// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { templateLabel } from "../src/renderer/src/components/settings/datasourceTemplates";
import { SourceIcon } from "../src/renderer/src/components/settings/SourceIcon";
import { canonicalDatasourceTemplate, datasourceTemplateOf } from "../src/shared/datasource-template";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

describe("canonicalDatasourceTemplate", () => {
	it("maps the pre-rename Hister template to Nogon and leaves every other id alone", () => {
		expect(canonicalDatasourceTemplate("hister")).toBe("nogon");
		expect(canonicalDatasourceTemplate("nogon")).toBe("nogon");
		expect(canonicalDatasourceTemplate("slack")).toBe("slack");
		expect(canonicalDatasourceTemplate("")).toBe("");
	});

	it("resolves a stored entry's template from its `type`, else its alias, canonically", () => {
		expect(datasourceTemplateOf("browser", { type: "hister" })).toBe("nogon");
		expect(datasourceTemplateOf("hister", {})).toBe("nogon");
		expect(datasourceTemplateOf("hister", undefined)).toBe("nogon");
		expect(datasourceTemplateOf("work", { type: "slack" })).toBe("slack");
		expect(datasourceTemplateOf("slack", { type: 3 })).toBe("slack");
		expect(datasourceTemplateOf("x", { type: "" })).toBe("x");
	});
});

describe("renderer lookups for a pre-rename `hister` type", () => {
	it("labels a legacy `hister` connection as Nogon", () => {
		expect(templateLabel("hister")).toBe("Nogon");
		expect(templateLabel("nogon")).toBe("Nogon");
	});

	it("draws the same icon for `hister` as for `nogon`", () => {
		const draw = (type: string): string => {
			const host = document.createElement("div");
			document.body.append(host);
			const root = createRoot(host);
			act(() => root.render(<SourceIcon type={type} label="Nogon" />));
			const html = host.innerHTML;
			act(() => root.unmount());
			host.remove();
			return html;
		};
		expect(draw("hister")).toBe(draw("nogon"));
		expect(draw("nogon")).toContain("<svg");
	});
});
