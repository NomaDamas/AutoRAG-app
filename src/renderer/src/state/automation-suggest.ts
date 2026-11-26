/**
 * Which automation a finished answer could quietly suggest (Figma 672:3658): one of the recommendations, when the
 * question or the files the answer used are about what that recommendation handles, no rule does it yet, and the
 * person has not put it off lately. It never decides for the person: the chat only offers it under the answer.
 */

export type SuggestableTemplate = "pdf" | "screenshot";

/** The words each recommendation answers to, in every language the app speaks. */
const SIGNALS: readonly (readonly [SuggestableTemplate, RegExp])[] = [
	["screenshot", /screen\s?shots?|스크린\s?샷|캡처|スクリーンショット|スクショ|截图|截屏|屏幕截图/i],
	["pdf", /\.pdf\b|\bpdfs?\b/i],
];

/** A suggestion put off with 나중에 stays quiet this long. */
export const LATER_MS = 7 * 24 * 60 * 60 * 1000;
const STORAGE_KEY = "dazzi.automationNudge.later";

export function suggestTemplate(text: string, taken: (id: SuggestableTemplate) => boolean, putOff: Readonly<Record<string, number>>, now: number = Date.now()): SuggestableTemplate | null {
	for (const [id, pattern] of SIGNALS) {
		if (!pattern.test(text)) continue;
		if (taken(id)) continue;
		const at = putOff[id];
		if (at !== undefined && now - at < LATER_MS) continue;
		return id;
	}
	return null;
}

/** The suggestions put off with 나중에 in this window's storage; a viewer convenience, so a missing store reads as none. */
export function readPutOff(): Readonly<Record<string, number>> {
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		const parsed: unknown = raw === null ? {} : JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, number>) : {};
	} catch {
		return {};
	}
}

export function putOff(id: SuggestableTemplate, now: number = Date.now()): void {
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readPutOff(), [id]: now }));
	} catch {
		// Without storage the suggestion may come back on the next answer; nothing else depends on it.
	}
}
