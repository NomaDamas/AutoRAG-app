/**
 * Name-collision helpers for Duplicate / Paste / Rename.
 *
 * The fs bridge resolves real collisions on disk (Finder-style " copy"
 * suffixes); these helpers produce the same names for the optimistic UI and
 * validate rename input before it crosses the bridge.
 */

import { t } from "../../../shared/i18n/core";

export interface SplitName {
	readonly stem: string;
	readonly ext: string;
}

export function splitName(name: string): SplitName {
	const dot = name.lastIndexOf(".");
	if (dot <= 0) {
		return { stem: name, ext: "" };
	}
	return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/** "report.pdf" → "report copy.pdf" → "report copy 2.pdf" … */
export function copyName(name: string, taken: readonly string[]): string {
	if (!taken.includes(name)) {
		return name;
	}
	const { stem, ext } = splitName(name);
	let candidate = `${stem} copy${ext}`;
	let counter = 2;
	while (taken.includes(candidate)) {
		candidate = `${stem} copy ${counter}${ext}`;
		counter += 1;
	}
	return candidate;
}

export type NameCheck = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** Rename validation. `current` keeps an unchanged name valid. */
export function validateName(name: string, taken: readonly string[], current?: string): NameCheck {
	const trimmed = name.trim();
	if (trimmed === "") {
		return { ok: false, message: t("finderState.renameEmpty") };
	}
	if (trimmed.includes("/")) {
		return { ok: false, message: t("finderState.renameSlash") };
	}
	if (current !== undefined && trimmed === current) {
		return { ok: true };
	}
	if (taken.includes(trimmed)) {
		return { ok: false, message: t("finderState.renameDuplicate") };
	}
	return { ok: true };
}
