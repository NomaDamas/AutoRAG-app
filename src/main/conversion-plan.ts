import { reachableTargets, SOURCE_FAMILIES } from "@autorag/librarian";
import type { ConversionPlan } from "../shared/conversion-contract";
import { FILEE_FORMAT_ALIASES } from "./conversion-aliases";

/** The last extension, lower-case, or "" when the name has none (a leading dot is a dotfile, not an extension). */
function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	if (dot <= 0 || dot === name.length - 1) return "";
	return name.slice(dot + 1).toLowerCase();
}

/** The id the route matrix (and `filee --to`) uses for an extension: `jpeg` is `jpg`, `htm` is `html`. */
export function canonicalFormat(extension: string): string {
	return Object.hasOwn(FILEE_FORMAT_ALIASES, extension) ? (FILEE_FORMAT_ALIASES[extension] as string) : extension;
}

/**
 * What renaming `oldName` to `newName` means. Pure and offline: it answers from
 * the librarian's route matrix (the table `convert_files` plans with) plus
 * Filee's alternative spellings, so the question never waits on a download.
 * Only a change between two present, different formats is a conversion.
 */
export function planConversion(oldName: string, newName: string): ConversionPlan {
	const from = extensionOf(oldName);
	const to = extensionOf(newName);
	if (from === "" || to === "") return { kind: "rename" };
	const source = canonicalFormat(from);
	const target = canonicalFormat(to);
	if (source === target) return { kind: "rename" };
	const family = Object.entries(SOURCE_FAMILIES).find(([, members]) => members.includes(source))?.[0];
	if (family === undefined || !reachableTargets(family).includes(target)) return { kind: "unsupported", from, to };
	return { kind: "convert", from, to };
}
