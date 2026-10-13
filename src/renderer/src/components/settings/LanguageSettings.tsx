import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Combobox } from "@base-ui/react";
import type { AutoRagConfigSnapshot, JsonObject, JsonValue } from "../../../../shared/settings-contract";
import { isJsonObject } from "../../../../shared/settings-contract";
import { settings } from "../../settings-runtime";

export const SUPPORTED_LANGUAGES = [
	{ value: "ko", label: "한국어" },
	{ value: "en", label: "English" },
	{ value: "ja", label: "日本語" },
	{ value: "zh-hans", label: "简体中文" },
	{ value: "zh-hant", label: "繁體中文" },
	{ value: "fr", label: "Français" },
	{ value: "de", label: "Deutsch" },
	{ value: "es", label: "Español" },
	{ value: "ru", label: "Русский" },
	{ value: "it", label: "Italiano" },
	{ value: "pt", label: "Português" },
	{ value: "vi", label: "Tiếng Việt" },
	{ value: "th", label: "ไทย" },
	{ value: "ar", label: "العربية" },
	{ value: "hi", label: "हिन्दी" },
] as const;

type LanguageValue = (typeof SUPPORTED_LANGUAGES)[number]["value"];
type ConfigPath = readonly string[];

const LANGUAGE_ITEMS: LanguageValue[] = SUPPORTED_LANGUAGES.map((language) => language.value);
const SUPPORTED_VALUES = new Set<string>(LANGUAGE_ITEMS);
const LABELS = new Map<string, string>(SUPPORTED_LANGUAGES.map((language) => [language.value, language.label]));

function readAt(root: JsonObject, path: ConfigPath): JsonValue | undefined {
	let current: JsonValue = root;
	for (const part of path) {
		if (!isJsonObject(current)) return undefined;
		current = current[part] as JsonValue;
	}
	return current;
}

function stringList(value: JsonValue | undefined): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => (typeof item === "string" && SUPPORTED_VALUES.has(item) ? [item] : []));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function LanguageSettings({
	snapshot,
	path,
	name,
	hint,
	onSaved,
	fallback = [],
}: {
	readonly snapshot: AutoRagConfigSnapshot;
	readonly path: ConfigPath;
	readonly name: string;
	readonly hint: string;
	readonly onSaved: (next: AutoRagConfigSnapshot) => void;
	readonly fallback?: readonly string[];
}): ReactElement {
	const { t } = useTranslation();
	const stored = readAt(snapshot.config, path);
	const configured = Array.isArray(stored);
	const inherited = fallback.filter((value) => SUPPORTED_VALUES.has(value));
	const effective = configured ? stringList(stored) : inherited;
	const signature = JSON.stringify({ configured, effective });
	const [selected, setSelected] = useState<string[]>(effective);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	useEffect(() => setSelected(effective), [signature]);

	const selectedSet = useMemo(() => new Set(selected), [selected]);

	async function save(next: readonly string[]): Promise<void> {
		const storedValues = [...new Set(next)].filter((value): value is LanguageValue => SUPPORTED_VALUES.has(value));
		setSaving(true);
		setError(null);
		try {
			const result = await settings.configPatch([
				storedValues.length === 0 ? { path: [...path], remove: true } : { path: [...path], value: storedValues },
			]);
			onSaved(result);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setSaving(false);
		}
	}

	function select(next: readonly string[]): void {
		const values = [...new Set(next)];
		setSelected(values);
		void save(values);
	}

	return (
		<div className="linear-row">
			<div className="linear-row-label">
				<span className="linear-row-name">{name}</span>
				<small>{hint}</small>
			</div>
			<div className="linear-control language-combobox-control">
				<Combobox.Root<string, true>
					multiple
					items={LANGUAGE_ITEMS}
					value={selected}
					onValueChange={select}
					inputValue={query}
					onInputValueChange={setQuery}
					autoHighlight={true}
					disabled={saving}
				>
					<div className="language-combobox">
						<div className="language-combobox__chips" aria-label={name}>
							{selected.map((value) => (
								<span className="language-combobox__chip" key={value}>
									{LABELS.get(value) ?? value}
									<button type="button" className="language-combobox__remove" aria-label={t("settingsCore.language.remove", { name: LABELS.get(value) ?? value })} onClick={() => select(selected.filter((item) => item !== value))}>
										×
									</button>
								</span>
							))}
							<Combobox.Input className="language-combobox__input" placeholder={t("settingsCore.language.placeholder")} aria-label={t("settingsCore.language.search", { name })} />
							<Combobox.Trigger className="language-combobox__trigger" aria-label={t("settingsCore.language.openList", { name })}>
								⌄
							</Combobox.Trigger>
						</div>
						<Combobox.Portal>
							<Combobox.Positioner className="language-combobox__positioner" side="bottom" align="start" sideOffset={4}>
								<Combobox.Popup className="language-combobox__popup">
									<Combobox.List className="language-combobox__list">
										{(value: string) => (
											<Combobox.Item className="language-combobox__item" key={value} value={value}>
												<span>{LABELS.get(value) ?? value}</span>
												<Combobox.ItemIndicator className="language-combobox__indicator">{selectedSet.has(value) ? "✓" : ""}</Combobox.ItemIndicator>
											</Combobox.Item>
										)}
									</Combobox.List>
									<Combobox.Empty className="language-combobox__empty">{t("settingsCore.language.noMatch")}</Combobox.Empty>
								</Combobox.Popup>
							</Combobox.Positioner>
						</Combobox.Portal>
					</div>
				</Combobox.Root>
				{configured && fallback.length > 0 ? <span className="settings-config__note">{t("settingsCore.language.custom")}</span> : null}
				{!configured && fallback.length > 0 ? <span className="settings-config__note">{t("settingsCore.language.inherited")}</span> : null}
				{stored !== undefined ? <button type="button" className="linear-btn settings-config__reset" disabled={saving} onClick={() => void save([])}>{t("settingsCore.language.resetDefault")}</button> : null}
				{error ? <span className="settings-inline-error">{error}</span> : null}
			</div>
		</div>
	);
}
