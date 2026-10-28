import type { LocaleKey } from "../../../shared/i18n/core";
import { hostPlatform } from "./shortcuts";

/**
 * Sentences that name the machine ("this Mac") have a Windows twin that says "this PC"; the key of the twin is the
 * Mac key plus `Pc`, the same convention the onboarding steps and the scope bar already use.
 */
const PC_VARIANTS = {
	"settingsCore.embedding.apiKeyHint": "settingsCore.embedding.apiKeyHintPc",
	"settingsCore.ai.server.bodyLocal": "settingsCore.ai.server.bodyLocalPc",
} as const satisfies Readonly<Record<string, LocaleKey>>;

/** The key to translate for `key` on `platform` (the host's by default): the PC twin on Windows, `key` elsewhere. */
export function platformKey(key: keyof typeof PC_VARIANTS, platform: string = hostPlatform()): LocaleKey {
	return platform === "win32" ? PC_VARIANTS[key] : key;
}
