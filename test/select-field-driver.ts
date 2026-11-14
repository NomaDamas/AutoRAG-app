import { act } from "react";

/** The label a SelectField trigger shows (what `selectedOptions[0].textContent` read on the native select). */
export function selectFieldText(trigger: Element | null): string | null {
	return trigger?.querySelector(".select-field__value")?.textContent ?? null;
}

/** Opens a SelectField with the pointer and picks the option with this label, as a user would. */
export async function pickSelectOption(trigger: Element | null, label: string): Promise<void> {
	if (!(trigger instanceof HTMLElement)) throw new Error("SelectField trigger not found");
	await act(async () => {
		trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 }));
		trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
		trigger.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse", button: 0 }));
		trigger.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
		trigger.click();
	});
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
	const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((candidate) => candidate.textContent?.replace("✓", "").trim() === label);
	if (option === undefined) {
		const seen = [...document.querySelectorAll('[role="option"]')].map((candidate) => candidate.textContent);
		throw new Error(`option "${label}" not in the open list: ${JSON.stringify(seen)}`);
	}
	await act(async () => {
		option.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 }));
		option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
		option.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse", button: 0 }));
		option.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
		option.click();
	});
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}
