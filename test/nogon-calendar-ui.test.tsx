// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEMPLATE_BY_ID } from "../src/renderer/src/components/settings/datasourceTemplates";
import { SourceIcon } from "../src/renderer/src/components/settings/SourceIcon";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.restoreAllMocks();
});

describe("Nogon and Calendar datasource templates and icons", () => {
	it("registers nogon and calendar templates with their connector field schemas", () => {
		const nogon = TEMPLATE_BY_ID.nogon;
		expect(nogon).toBeDefined();
		expect(nogon?.binary).toBe("nogon");
		expect(nogon?.polling).toBe(false);
		expect(nogon?.channels).toBe("none");
		const nogonFields = nogon?.groups.flatMap((group) => group.fields.map((field) => [field.key, field.kind]));
		expect(nogonFields).toEqual([
			["baseUrl", "text"],
			["tokenEnv", "text"],
			["semantic", "boolean"],
			["timeoutMs", "number"],
		]);

		const calendar = TEMPLATE_BY_ID.calendar;
		expect(calendar).toBeDefined();
		expect(calendar?.binary).toBe("npx");
		expect(calendar?.polling).toBe(false);
		expect(calendar?.channels).toBe("none");
		const calendarFields = calendar?.groups.flatMap((group) => group.fields.map((field) => [field.key, field.kind]));
		expect(calendarFields).toEqual([
			["requireWriteConfirmation", "boolean"],
			["exposure", "select"],
			["command", "text"],
			["args", "stringList"],
		]);
	});

	it("renders SVG icons for nogon, calendar, and apple-events", () => {
		act(() => {
			root.render(
				<div>
					<SourceIcon type="nogon" label="Nogon" />
					<SourceIcon type="calendar" label="Apple Calendar & Reminders" />
					<SourceIcon type="apple-events" label="Apple Events" />
				</div>,
			);
		});
		const icons = host.querySelectorAll("svg[role='img']");
		expect(icons.length).toBe(3);
	});
});

describe("AI Sessions (wombat) template and icon", () => {
	it("is registered as AI Sessions with the wombat CLI and the connector fields wombat reads", () => {
		const wombat = TEMPLATE_BY_ID.wombat;
		expect(wombat).toBeDefined();
		expect(wombat?.label).toBe("AI Sessions");
		expect(wombat?.binary).toBe("wombat");
		expect(wombat?.channels).toBe("none");
		expect(wombat?.polling).toBe(true);
		const fields = wombat?.groups.flatMap((group) => group.fields.map((field) => [field.key, field.kind]));
		expect(fields).toEqual([
			["agents", "stringList"],
			["includeSubagents", "boolean"],
			["includeEphemeral", "boolean"],
			["dataDir", "text"],
			["binaryPath", "text"],
			["timeoutMs", "number"],
			["indexTimeoutMs", "number"],
			["maxBufferBytes", "number"],
			["env", "env"],
		]);
	});

	it("never offers a field the librarian's wombat skill does not read", () => {
		const known = new Set(["agents", "sources", "includeSubagents", "includeEphemeral", "dataDir", "configPath", "binaryPath", "timeoutMs", "indexTimeoutMs", "maxBufferBytes", "env"]);
		for (const group of TEMPLATE_BY_ID.wombat?.groups ?? []) for (const field of group.fields) expect(known.has(field.key), field.key).toBe(true);
	});

	it("draws a glyph, not the first-letter fallback", () => {
		act(() => root.render(<SourceIcon type="wombat" label="AI Sessions" />));
		expect(host.querySelector("svg")).not.toBeNull();
	});
});
