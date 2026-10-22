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

describe("Hister and Calendar datasource templates and icons", () => {
	it("registers hister and calendar templates with their connector field schemas", () => {
		const hister = TEMPLATE_BY_ID.hister;
		expect(hister).toBeDefined();
		expect(hister?.binary).toBe("hister");
		expect(hister?.polling).toBe(false);
		expect(hister?.channels).toBe("none");
		const histerFields = hister?.groups.flatMap((group) => group.fields.map((field) => [field.key, field.kind]));
		expect(histerFields).toEqual([
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

	it("renders SVG icons for hister, calendar, and apple-events", () => {
		act(() => {
			root.render(
				<div>
					<SourceIcon type="hister" label="Hister" />
					<SourceIcon type="calendar" label="Apple Calendar & Reminders" />
					<SourceIcon type="apple-events" label="Apple Events" />
				</div>,
			);
		});
		const icons = host.querySelectorAll("svg[role='img']");
		expect(icons.length).toBe(3);
	});
});
