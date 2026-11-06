/**
 * Settings → General → Quick Search: turn the system-wide launcher shortcut on or off and record a new chord.
 *
 * While the recorder listens, the main process releases the global shortcut (`setRecording`), so pressing the current
 * chord reaches the recorder instead of summoning the launcher. A chord the OS refuses (another app holds it) is
 * reported under the row rather than saved as if it worked.
 */

import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { LocaleKey } from "../../../../shared/i18n/core";
import { isGlobalChord, type QuickSearchSettings, type QuickSearchStatus } from "../../../../shared/quick-search-contract";
import type { AppSettings } from "../../../../shared/settings-contract";
import { chordFromKeyEvent, formatHeldModifiers, formatShortcutChord } from "../../../../shared/shortcuts-contract";
import { hostPlatform } from "../../lib/shortcuts";
import { Switch } from "../primitives/Switch";
import { Note, Row, Section } from "./SettingsKit";

const autorag = window.autorag;

export function QuickSearchSettingsSection({
	settings,
	setApp,
}: {
	readonly settings: QuickSearchSettings;
	readonly setApp: (patch: Partial<AppSettings>) => Promise<void>;
}): ReactElement {
	const { t } = useTranslation();
	const platform = hostPlatform();
	const [recording, setRecording] = useState(false);
	const [held, setHeld] = useState("");
	const [invalid, setInvalid] = useState<LocaleKey | null>(null);
	const [status, setStatus] = useState<QuickSearchStatus | null>(null);

	// The status follows every change: a new chord or the switch re-registers in main before the settings echo arrives.
	useEffect(() => {
		let live = true;
		void autorag.quickSearch?.status().then((next) => {
			if (live) setStatus(next);
		});
		return () => {
			live = false;
		};
	}, [settings.enabled, settings.chord, recording]);

	useEffect(() => {
		if (!recording) return;
		void autorag.quickSearch?.setRecording(true);
		const stop = (): void => {
			setRecording(false);
			setHeld("");
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation();
			const decoded = chordFromKeyEvent(event, platform);
			if (decoded.kind === "cancel") return stop();
			if (decoded.kind === "modifier-only") {
				setHeld(formatHeldModifiers(decoded, platform));
				return;
			}
			if (decoded.kind === "invalid" || !isGlobalChord(decoded.chord)) {
				setHeld("");
				setInvalid(decoded.kind === "invalid" && decoded.reason === "reserved-escape" ? "settingsCore.shortcuts.invalidReservedEscape" : "settingsCore.general.quickSearchNeedsModifier");
				return;
			}
			setInvalid(null);
			stop();
			void setApp({ quickSearch: { ...settings, chord: decoded.chord } });
		};
		const onPointerDown = (event: MouseEvent): void => {
			if (event.target instanceof HTMLElement && event.target.closest("[data-quick-search-record]") !== null) return;
			stop();
		};
		window.addEventListener("keydown", onKeyDown, { capture: true });
		window.addEventListener("mousedown", onPointerDown, { capture: true });
		return () => {
			window.removeEventListener("keydown", onKeyDown, { capture: true });
			window.removeEventListener("mousedown", onPointerDown, { capture: true });
			void autorag.quickSearch?.setRecording(false);
		};
	}, [recording, platform, setApp, settings]);

	const current = formatShortcutChord(settings.chord, platform);
	return (
		<Section title={t("settingsCore.general.quickSearchTitle")} description={t("settingsCore.general.quickSearchDesc")}>
			<Row name={t("settingsCore.general.quickSearchEnabled")} hint={t("settingsCore.general.quickSearchEnabledHint", { shortcut: current })}>
				<Switch
					checked={settings.enabled}
					onChange={() => void setApp({ quickSearch: { ...settings, enabled: !settings.enabled } })}
					ariaLabel={t("settingsCore.general.quickSearchEnabled")}
					dataSwitchId="quick-search"
				/>
			</Row>
			<Row name={t("settingsCore.general.quickSearchShortcut")} hint={t("settingsCore.general.quickSearchShortcutHint")}>
				<button
					type="button"
					data-quick-search-record
					className={`shortcut-recorder-btn${recording ? " is-recording" : ""}`}
					disabled={!settings.enabled}
					aria-label={t("settingsCore.shortcuts.recordButtonHint", { shortcut: current })}
					title={t("settingsCore.shortcuts.recordButtonHint", { shortcut: current })}
					onClick={() => {
						setInvalid(null);
						setRecording((value) => !value);
					}}
				>
					{recording ? (
						<>
							<span className="shortcut-recorder-btn__dot" aria-hidden="true" />
							<span className="shortcut-recorder-btn__prompt">{held.length > 0 ? held : t("settingsCore.shortcuts.recordingPrompt")}</span>
						</>
					) : (
						current
					)}
				</button>
			</Row>
			{invalid !== null ? <Note>{t(invalid)}</Note> : null}
			{settings.enabled && status?.error === "taken" ? <Note>{t("settingsCore.general.quickSearchTaken", { shortcut: current })}</Note> : null}
		</Section>
	);
}
