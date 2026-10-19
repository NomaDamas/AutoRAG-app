import { setAppLanguage } from "../../../shared/i18n";
import type { AppSettings } from "../../../shared/settings-contract";

/**
 * Puts this window in the stored interface language before it first renders.
 * The onboarding flow mounts ahead of the Finder, which is where the language
 * used to be applied, so without this it showed the Korean default until the
 * Finder loaded. A settings read that fails keeps the default.
 */
export async function applyInterfaceLanguage(settings: { readonly get: () => Promise<Pick<AppSettings, "language">> }): Promise<void> {
	try {
		const { language } = await settings.get();
		await setAppLanguage(language);
		document.documentElement.lang = language;
	} catch (error) {
		console.error("[i18n] interface language not applied:", error);
	}
}
