import { calendarSupported, isCalendarDatasourceType } from "./calendar-platform";

/**
 * KakaoTalk is read through `lazykatok`, which is an Apple Silicon macOS program (it opens the Mac app's
 * container and auth cache; there is no Windows build, in its code or in its releases). One rule for every
 * surface, like {@link calendarSupported}: onboarding does not offer it, Settings does not list it, the refresh
 * never runs it, and a config row inherited from a Mac reports "unsupported" instead of a missing CLI.
 */
export function kakaoSupported(platform: string): boolean {
	return platform === "darwin";
}

/**
 * Datasources whose backend only works on a Mac, besides Apple Calendar & Reminders ({@link calendarSupported}):
 * - `kakao`: `lazykatok` reads the Mac app's container.
 * - `whatsapp`: `wacrawl` snapshots WhatsApp Desktop's `ChatStorage.sqlite` from the macOS group container, and its
 *   default source path is empty on every other OS ("WhatsApp desktop path is only auto-detected on macOS").
 * - `spotlight`: `mdfind` and the Spotlight index.
 */
const MAC_ONLY_TEMPLATES: Readonly<Record<string, true>> = { kakao: true, whatsapp: true, spotlight: true };

/** Whether a datasource template can run on `platform`; everything not named above is offered everywhere. */
export function datasourceSupported(type: string, platform: string): boolean {
	if (isCalendarDatasourceType(type)) return calendarSupported(platform);
	return platform === "darwin" || MAC_ONLY_TEMPLATES[type] !== true;
}

/** The template a config datasource entry runs as: its `type`, else its alias. */
export function datasourceEntryType(alias: string, entry: unknown): string {
	return typeof entry === "object" && entry !== null && "type" in entry && typeof entry.type === "string" ? entry.type : alias;
}

/**
 * Whether a config datasource entry can run on `platform`. A WhatsApp entry that names the folder `wacrawl` should
 * read (`connector.sourcePath`) is the one exception: the only thing wacrawl cannot find off macOS is that folder.
 */
export function datasourceEntrySupported(alias: string, entry: unknown, platform: string): boolean {
	const type = datasourceEntryType(alias, entry);
	if (datasourceSupported(type, platform)) return true;
	if (type !== "whatsapp" || typeof entry !== "object" || entry === null || !("connector" in entry)) return false;
	const connector = entry.connector;
	return typeof connector === "object" && connector !== null && "sourcePath" in connector && typeof connector.sourcePath === "string" && connector.sourcePath.trim().length > 0;
}
