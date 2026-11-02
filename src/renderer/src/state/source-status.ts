/**
 * The status dot beside a sidebar row is not data of the row: it is the live state of the datasource behind it,
 * read from `settings.sourcesList` and keyed by the row's glyph.
 */

import type { FsLocationIcon } from "../../../shared/fs-contract";
import type { DataSourcesSnapshot } from "../../../shared/settings-contract";

export type SourceStatusMap = Readonly<Partial<Record<FsLocationIcon, "syncing" | "error">>>;

/** Sidebar cloud glyphs → live datasource rows (status dots on every account of that provider). */
const SOURCE_ICON_MATCH: readonly (readonly [FsLocationIcon, RegExp])[] = [
	["google-drive", /gdrive|google[- ]?drive/i],
	["dropbox", /dropbox/i],
	["icloud", /icloud/i],
	["onedrive", /onedrive/i],
];

export function mapSourceStatus(snapshot: DataSourcesSnapshot): SourceStatusMap {
	const out: Partial<Record<FsLocationIcon, "syncing" | "error">> = {};
	for (const [icon, needle] of SOURCE_ICON_MATCH) {
		const row = snapshot.sources.find((source) => needle.test(source.id) || needle.test(source.type));
		if (row === undefined) continue;
		if (row.status === "syncing") out[icon] = "syncing";
		else if (row.status === "attention") out[icon] = "error";
	}
	// The Discord row opens the attachments of every Discord connection, whatever each is named, so one dot
	// answers for all of them and the worst state wins.
	const discord = snapshot.sources.filter((source) => source.type === "discord");
	if (discord.some((source) => source.status === "attention")) out.discord = "error";
	else if (discord.some((source) => source.status === "syncing")) out.discord = "syncing";
	return out;
}
