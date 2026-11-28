// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sourceTitle, templateLabel } from "../src/renderer/src/components/settings/datasourceTemplates";
import { SourceIcon } from "../src/renderer/src/components/settings/SourceIcon";
import { setAppLanguage } from "../src/shared/i18n";
import {
	canonicalDatasourceTemplate,
	datasourceTemplateOf,
	defaultConnectionAlias,
	isImpliedConnectionAlias,
} from "../src/shared/datasource-template";

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
	it("labels a legacy `hister` connection as browser history", async () => {
		await setAppLanguage("en");
		expect(templateLabel("hister")).toBe("Browser history");
		expect(templateLabel("nogon")).toBe("Browser history");
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

describe("a person knows it as their browser history, not by the program name", () => {
	beforeEach(async () => setAppLanguage("en"));
	afterEach(async () => setAppLanguage("en"));

	it("is named in the interface language", async () => {
		expect(templateLabel("nogon")).toBe("Browser history");
		await setAppLanguage("ko");
		expect(templateLabel("nogon")).toBe("브라우저 기록");
		expect(templateLabel("hister")).toBe("브라우저 기록");
		await setAppLanguage("ja");
		expect(templateLabel("nogon")).toBe("ブラウザ履歴");
		await setAppLanguage("zh");
		expect(templateLabel("nogon")).toBe("浏览器历史记录");
	});

	it("hides a connection name that only restates the program, whatever it is called in config.json", async () => {
		for (const id of ["browser", "hister", "nogon", "browser-history"]) {
			expect(sourceTitle({ id, type: "nogon" })).toBe("Browser history");
			expect(sourceTitle({ id, type: "hister" })).toBe("Browser history");
		}
		await setAppLanguage("ko");
		expect(sourceTitle({ id: "browser", type: "nogon" })).toBe("브라우저 기록");
		expect(sourceTitle({ id: "hister", type: "nogon" })).toBe("브라우저 기록");
	});

	it("keeps a name that tells two connections apart", () => {
		expect(sourceTitle({ id: "work", type: "nogon" })).toBe("Browser history · work");
		expect(sourceTitle({ id: "work", type: "slack" })).toBe("Slack · work");
		expect(sourceTitle({ id: "slack", type: "slack" })).toBe("Slack");
	});

	it("starts a new connection as `browser`, and every other template under its own id", () => {
		expect(defaultConnectionAlias("nogon")).toBe("browser");
		expect(defaultConnectionAlias("hister")).toBe("browser");
		expect(defaultConnectionAlias("slack")).toBe("slack");
		expect(isImpliedConnectionAlias("nogon", "browser")).toBe(true);
		expect(isImpliedConnectionAlias("nogon", "hister")).toBe(true);
		expect(isImpliedConnectionAlias("nogon", "work")).toBe(false);
		expect(isImpliedConnectionAlias("slack", "slack")).toBe(true);
		expect(isImpliedConnectionAlias("slack", "browser")).toBe(false);
	});
});
