// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectField } from "../src/renderer/src/components/settings/SelectField";
import { pickSelectOption, selectFieldText } from "./select-field-driver";

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
});

const OPTIONS = [
	{ value: "", label: "Automatic" },
	{ value: "a", label: "Alpha" },
	{ value: "b", label: "Beta" },
];

describe("SelectField (the Settings dropdown in the 문서 읽기 style)", () => {
	it("shows the chosen label, including the option whose value is empty", async () => {
		await act(async () => root.render(<SelectField aria-label="Engine" value="" options={OPTIONS} onValueChange={() => undefined} />));
		const trigger = host.querySelector('[aria-label="Engine"]');
		expect(trigger?.classList.contains("select-field")).toBe(true);
		expect(selectFieldText(trigger)).toBe("Automatic");
	});

	it("opens its own list and reports the picked value, mapping the empty option back to \"\"", async () => {
		const onValueChange = vi.fn();
		await act(async () => root.render(<SelectField aria-label="Engine" value="a" options={OPTIONS} onValueChange={onValueChange} />));
		await pickSelectOption(host.querySelector('[aria-label="Engine"]'), "Beta");
		expect(onValueChange).toHaveBeenLastCalledWith("b");
		await pickSelectOption(host.querySelector('[aria-label="Engine"]'), "Automatic");
		expect(onValueChange).toHaveBeenLastCalledWith("");
	});

	it("draws the list as the language-combobox popup", async () => {
		await act(async () => root.render(<SelectField aria-label="Engine" value="a" options={OPTIONS} onValueChange={() => undefined} />));
		await pickSelectOption(host.querySelector('[aria-label="Engine"]'), "Alpha");
		await act(async () => (host.querySelector('[aria-label="Engine"]') as HTMLElement).click());
		expect(document.querySelector(".select-field__positioner .language-combobox__popup")).not.toBeNull();
	});
});
