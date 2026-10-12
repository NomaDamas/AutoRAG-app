/**
 * Version families (handoff README §2 "File rows", prototype `FAMS`).
 *
 * A family groups duplicate or near-duplicate documents behind one head row.
 * Members whose head lives in the same folder are hidden from the flat list
 * and appear only when the stack expands; members in other folders keep their
 * own flat row and also appear as children when the stack is open.
 */

import type { FinderEntry } from "../data/entries";
import { locationOf } from "./entry-values";
import { basename, dirname } from "./paths";

export type VersionRelation = "exact" | "near" | "contains";

export interface VersionMember {
	readonly path: string;
	readonly relation: VersionRelation;
}

export interface VersionFamilyData {
	readonly head: string;
	readonly members: readonly VersionMember[];
	readonly entriesByPath: Readonly<Record<string, FinderEntry>>;
}

/** The locale key of each family badge; the head row's badge is `latest`. */
export const VERSION_TAG_KEYS = {
	latest: "inspector.latestVersion",
	exact: "inspector.versionRelations.exact",
	near: "inspector.versionRelations.near",
	contains: "inspector.versionRelations.contains",
} as const satisfies Readonly<Record<"latest" | VersionRelation, string>>;

export interface ResolvedMembership {
	readonly family: VersionFamilyData;
	readonly relation: VersionRelation;
}

export interface VersionFamilies {
	readonly byHead: ReadonlyMap<string, VersionFamilyData>;
	readonly memberOf: ReadonlyMap<string, ResolvedMembership>;
}

/** Inspector "Versions" section: the family one path belongs to, flattened for display. */
export interface VersionFamilyViewMember {
	readonly path: string;
	readonly name: string;
	readonly relation: VersionRelation;
	/** Parent folder of the member — shown as the location chip. */
	readonly where: string;
}

export interface VersionFamilyView {
	readonly headPath: string;
	readonly headName: string;
	readonly members: readonly VersionFamilyViewMember[];
}

/**
 * The family `path` heads or belongs to, or null. Head lookups win so the
 * head row and any member row present the same section.
 */
export function familyViewFor(path: string, families: VersionFamilies): VersionFamilyView | null {
	const head = families.byHead.get(path);
	const data = head ?? families.memberOf.get(path)?.family;
	if (data === undefined) return null;
	return {
		headPath: data.head,
		headName: basename(data.head),
		members: data.members.map((member) => ({
			path: member.path,
			name: basename(member.path),
			relation: member.relation,
			where: dirname(member.path),
		})),
	};
}

export interface VersionFamilyError {
	readonly code: "dupey-missing" | "scan-failed";
	readonly message: string;
	readonly installCommand: string | null;
}

export interface VersionFamiliesResult {
	readonly families: readonly VersionFamilyData[];
	readonly scannedAt: string | null;
	readonly error: VersionFamilyError | null;
}

export const EMPTY_VERSION_FAMILIES: VersionFamilies = {
	byHead: new Map(),
	memberOf: new Map(),
};

export const EMPTY_VERSION_FAMILIES_RESULT: VersionFamiliesResult = {
	families: [],
	scannedAt: null,
	error: null,
};

export function buildVersionFamilies(families: readonly VersionFamilyData[]): VersionFamilies {
	const byHead = new Map<string, VersionFamilyData>();
	const memberOf = new Map<string, ResolvedMembership>();
	for (const family of families) {
		if (byHead.has(family.head)) continue;
		byHead.set(family.head, family);
		for (const member of family.members) {
			if (member.path === family.head || memberOf.has(member.path)) continue;
			memberOf.set(member.path, { family, relation: member.relation });
		}
	}
	return { byHead, memberOf };
}

/** One rendered row after the version-stack pass. */
export interface StackRow {
	readonly entry: FinderEntry;
	readonly stackCount: number;
	readonly stackOpen: boolean;
	readonly child: boolean;
	readonly relation: VersionRelation | null;
}

export interface StackOptions {
	readonly families: VersionFamilies;
	readonly manualOpen: ReadonlySet<string>;
	readonly selectedKeys: readonly string[];
}

/**
 * Applies the prototype's `curRows` stack rules to a sorted flat listing:
 *
 * - A member whose head is in the same folder is hidden from the flat list.
 * - A head row carries the live member count and opens when selected
 *   (itself or any member) or pinned open through the badge.
 * - Open stacks append their member rows, cross-folder ones included, as
 *   indented children right after the head.
 */
export function applyVersionStacks(
	rows: readonly FinderEntry[],
	options: StackOptions,
): readonly StackRow[] {
	const { families, manualOpen, selectedKeys } = options;
	if (families.byHead.size === 0) return rows.map(stackRow);

	const selected = new Set(selectedKeys);
	const pathsInRows = new Set(rows.map((r) => r.path));
	const out: StackRow[] = [];
	for (const entry of rows) {
		const membership = families.memberOf.get(entry.path);
		if (membership !== undefined) {
			const headDir = dirname(membership.family.head);
			if (headDir === locationOf(entry) && pathsInRows.has(membership.family.head)) continue;
		}
		const family = families.byHead.get(entry.path);
		if (family === undefined) {
			out.push(stackRow(entry));
			continue;
		}
		const members = family.members.filter(
			(member) => family.entriesByPath[member.path] !== undefined,
		);
		const open =
			members.length > 0 &&
			(manualOpen.has(entry.path) ||
				selected.has(entry.path) ||
				members.some((member) => selected.has(member.path)));
		out.push({ entry, stackCount: members.length, stackOpen: open, child: false, relation: null });
		if (open) {
			for (const member of members) {
				const memberEntry = family.entriesByPath[member.path];
				if (memberEntry === undefined) continue;
				out.push({
					entry: memberEntry,
					stackCount: 0,
					stackOpen: false,
					child: true,
					relation: member.relation,
				});
			}
		}
	}
	return out;
}

function stackRow(entry: FinderEntry): StackRow {
	return { entry, stackCount: 0, stackOpen: false, child: false, relation: null };
}

/**
 * The selected paths that can open a stack (a family head or one of its
 * members), in selection order. Selecting a plain file opens nothing, so the
 * row pipeline keys its memo on this — not on the whole selection — and a
 * click on an ordinary row re-sorts nothing.
 */
export function stackSelectionKeys(selectedKeys: readonly string[], families: VersionFamilies): readonly string[] {
	if (families.byHead.size === 0) return NO_KEYS;
	const keys = selectedKeys.filter((key) => families.byHead.has(key) || families.memberOf.has(key));
	return keys.length === 0 ? NO_KEYS : keys;
}

const NO_KEYS: readonly string[] = [];

/** Stack members default to excluded from indexing (handoff README §2). */
export function defaultIndexIncluded(path: string, families: VersionFamilies): boolean {
	return !families.memberOf.has(path);
}
