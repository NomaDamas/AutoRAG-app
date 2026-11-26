/**
 * The "when you right-click …" trigger the 자동화 card and the 매직액션 modal share: which files the chip offers, how
 * a choice becomes a magic action's target, and the name a new one gets when the person gives none.
 */

import type { MagicActionSelectionRule, MagicActionTargetKind } from "../../../shared/context-menu-contract";

/** The file-kind chip's choices; `folder` and `both` exist only for a right-click (a watched folder has files). */
export type RightClickKind = "all" | "pdf" | "image" | "document" | "folder" | "both";

export const RIGHT_CLICK_KINDS: readonly RightClickKind[] = ["all", "pdf", "image", "document", "folder", "both"];
export const SELECTIONS: readonly MagicActionSelectionRule[] = ["single", "multiple", "any"];

export const IMAGE_EXTENSIONS: readonly string[] = ["png", "jpg", "jpeg", "heic", "gif", "webp"];
export const DOCUMENT_EXTENSIONS: readonly string[] = ["pdf", "doc", "docx", "hwp", "hwpx", "txt", "md", "ppt", "pptx", "xls", "xlsx"];

const KIND_EXTENSIONS: Readonly<Record<"all" | "pdf" | "image" | "document", readonly string[]>> = {
	all: [],
	pdf: ["pdf"],
	image: IMAGE_EXTENSIONS,
	document: DOCUMENT_EXTENSIONS,
};

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

/** What a magic action stores for a chip choice; `custom` is a typed extension list, which wins over the chip. */
export function rightClickTarget(kind: RightClickKind, custom: readonly string[] | null): { readonly targetKind: MagicActionTargetKind; readonly extensions: readonly string[] } {
	if (custom !== null && custom.length > 0) return { targetKind: "file", extensions: custom };
	if (kind === "folder") return { targetKind: "folder", extensions: [] };
	if (kind === "both") return { targetKind: "any", extensions: [] };
	return { targetKind: "file", extensions: KIND_EXTENSIONS[kind] };
}

/** The chip a stored action fits; an extension list no chip offers comes back as `custom`, kept as written. */
export function rightClickKindOf(targetKind: MagicActionTargetKind, extensions: readonly string[]): { readonly kind: RightClickKind; readonly custom: readonly string[] | null } {
	if (targetKind === "folder") return { kind: "folder", custom: null };
	if (targetKind === "any" && extensions.length === 0) return { kind: "both", custom: null };
	const match = (Object.keys(KIND_EXTENSIONS) as (keyof typeof KIND_EXTENSIONS)[]).find((kind) => sameSet(KIND_EXTENSIONS[kind], extensions));
	return match === undefined ? { kind: "all", custom: extensions } : { kind: match, custom: null };
}

const LABEL_MAX = 30;

/** The menu name a new action gets when the person names none: the first line of what it does, cut short. */
export function autoMagicLabel(task: string): string {
	const line = task
		.split("\n")
		.map((part) => part.trim())
		.find((part) => part.length > 0);
	if (line === undefined) return "";
	const chars = [...line];
	return chars.length <= LABEL_MAX ? line : `${chars.slice(0, LABEL_MAX - 1).join("").trimEnd()}…`;
}

/**
 * An id for a new action that no other action has: two actions with the same name stay two actions (the stored id
 * is otherwise the name's slug, and saving one would replace the other).
 */
export function newMagicActionId(label: string, taken: readonly string[]): string {
	const base =
		label
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9가-힣ぁ-んァ-ヶ一-龥_-]+/gu, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 48) || "magic";
	if (!taken.includes(base)) return base;
	for (let n = 2; ; n += 1) {
		const next = `${base}-${n}`;
		if (!taken.includes(next)) return next;
	}
}
