/**
 * KakaoTalk is read through `lazykatok`, which is an Apple Silicon macOS program (it opens the Mac app's
 * container and auth cache; there is no Windows build, in its code or in its releases). One rule for every
 * surface, like {@link calendarSupported}: onboarding does not offer it, Settings does not list it, the refresh
 * never runs it, and a config row inherited from a Mac reports "unsupported" instead of a missing CLI.
 */
export function kakaoSupported(platform: string): boolean {
	return platform === "darwin";
}

/** The datasource templates that exist only on some hosts; everything else is offered everywhere. */
export function datasourceSupported(type: string, platform: string): boolean {
	return type === "kakao" ? kakaoSupported(platform) : true;
}

/** Whether a config datasource entry is the KakaoTalk one (its `type`, else its alias). */
export function isKakaoEntry(alias: string, entry: unknown): boolean {
	const type = typeof entry === "object" && entry !== null && "type" in entry && typeof entry.type === "string" ? entry.type : alias;
	return type === "kakao";
}
