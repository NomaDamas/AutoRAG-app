// Drives a Settings SelectField (src/renderer/src/components/settings/SelectField.tsx) the way a user does:
// click the field, then click the row in its list. The field and each row carry `data-value`.

/** CSS selector for the SelectField with this accessible name. */
export const selectField = (label) => `.select-field[aria-label="${label}"]`;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Opens `trigger` (a Playwright Locator) and picks a row: a string is the option's value (what
 * `selectOption("en")` took), `{ label }` is its visible text.
 */
export async function pickSelect(trigger, choice) {
	await trigger.click();
	const page = trigger.page();
	const rows = page.locator('.select-field__positioner [role="option"]');
	const row =
		typeof choice === "string"
			? rows.and(page.locator(`[data-value="${choice.replaceAll('"', '\\"')}"]`))
			: rows.filter({ hasText: new RegExp(`^\\s*${escapeRegExp(choice.label)}\\s*✓?\\s*$`) });
	await row.first().click();
	await page.locator(".select-field__positioner").first().waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);
}

/** The value a SelectField shows (what `select.value` read). */
export async function selectValue(trigger) {
	return trigger.getAttribute("data-value");
}
