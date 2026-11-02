/**
 * Datasource template catalogue and connector field editors.
 *
 * The template metadata (`TEMPLATES` / `TEMPLATE_BY_ID`) describes every
 * built-in source's fields, channel/polling behaviour and summary; the
 * `ConnectorFieldInput` family renders those field specs. Extracted from the
 * retired full `DatasourceSettings` panel so the new Settings IA can reuse the
 * catalogue and editors without the legacy management UI.
 */

import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { LocaleKey } from "../../../../shared/i18n/core";
import { isJsonObject } from "../../../../shared/settings-contract";

/* ------------------------------------------------------------- field schema -- */

export type FieldKind = "text" | "number" | "boolean" | "select" | "stringList" | "pathList" | "env" | "feeds";

export interface FieldSpec {
	readonly key: string;
	readonly label: LocaleKey;
	readonly kind: FieldKind;
	readonly hint?: LocaleKey;
	readonly placeholder?: string;
	readonly options?: readonly string[];
	/** Maps select labels to stored JSON values (e.g. label "off" → false). */
	readonly optionValues?: Readonly<Record<string, unknown>>;
	/** Effective factory default for a boolean leaf when the key is absent. */
	readonly defaultValue?: boolean;
}

export interface FieldGroup {
	readonly title: LocaleKey;
	readonly fields: readonly FieldSpec[];
}

export interface TemplateMeta {
	readonly id: string;
	readonly label: string;
	readonly binary: string | null;
	readonly summary: LocaleKey;
	/** Which channel allowlists this template's factory forwards. */
	readonly channels: "none" | "ids" | "both";
	/** Whether the factory forwards `pollingIntervalMs`. */
	readonly polling: boolean;
	readonly groups: readonly FieldGroup[];
}

/** Shared advanced block for crawler-CLI templates (`CrawlerCliOptions`). */

const CRAWLER_ADVANCED: FieldGroup = {
	title: "settingsSources.groups.advancedRuntime",
	fields: [
		{ key: "binaryPath", label: "settingsSources.fields.binaryPath", kind: "text", hint: "settingsSources.fields.hint.binaryPathEmpty" },
		{ key: "databasePath", label: "settingsSources.fields.databasePath", kind: "text" },
		{ key: "sourcePath", label: "settingsSources.fields.sourcePath", kind: "text" },
		{ key: "configPath", label: "settingsSources.fields.configPath", kind: "text", hint: "settingsSources.fields.hint.nativeConfig" },
		{ key: "syncSource", label: "settingsSources.fields.syncSource", kind: "text" },
		{ key: "timeoutMs", label: "settingsSources.fields.searchTimeoutMs", kind: "number" },
		{ key: "indexTimeoutMs", label: "settingsSources.fields.indexTimeoutMs", kind: "number" },
		{ key: "maxBufferBytes", label: "settingsSources.fields.maxBufferBytes", kind: "number" },
		{ key: "env", label: "settingsSources.fields.env", kind: "env", hint: "settingsSources.fields.hint.env" },
	],
} as FieldGroup;

export const TEMPLATES: readonly TemplateMeta[] = [
	{
		id: "telegram",
		label: "Telegram",
		binary: "telecrawl",
		summary: "settingsSources.templates.telegram.summary",
		channels: "both",
		polling: true,
		groups: [{ title: "settingsSources.groups.telegram", fields: [] }, CRAWLER_ADVANCED],
	},
	{
		id: "whatsapp",
		label: "WhatsApp",
		binary: "wacrawl",
		summary: "settingsSources.templates.whatsapp.summary",
		channels: "both",
		polling: true,
		groups: [{ title: "settingsSources.groups.whatsapp", fields: [] }, CRAWLER_ADVANCED],
	},
	{
		id: "slack",
		label: "Slack",
		binary: "slacrawl",
		summary: "settingsSources.templates.slack.summary",
		channels: "both",
		polling: true,
		groups: [
			{ title: "settingsSources.groups.slack", fields: [{ key: "workspace", label: "settingsSources.fields.workspaceId", kind: "text", placeholder: "T0435JHH63Z", hint: "settingsSources.fields.hint.workspace" }] },
			CRAWLER_ADVANCED,
		],
	},
	{
		id: "discord",
		label: "Discord",
		binary: "discrawl",
		summary: "settingsSources.templates.discord.summary",
		channels: "both",
		polling: true,
		groups: [
			{
				title: "settingsSources.groups.discord",
				fields: [
					{ key: "guildId", label: "settingsSources.fields.guildId", kind: "text" },
					{ key: "defaultMode", label: "settingsSources.fields.defaultMode", kind: "select", options: ["hybrid", "fts", "semantic"] },
					{ key: "embeddingProvider", label: "settingsSources.fields.embeddingProvider", kind: "text", hint: "settingsSources.fields.hint.embeddingProvider" },
					{ key: "embeddingModel", label: "settingsSources.fields.embeddingModel", kind: "text", hint: "settingsSources.fields.hint.embeddingModel" },
					{ key: "embedLimit", label: "settingsSources.fields.embedLimit", kind: "number" },
				],
			},
			{
				title: "settingsSources.groups.advancedRuntime",
				fields: [
					{ key: "binaryPath", label: "settingsSources.fields.binaryPath", kind: "text" },
					{ key: "configPath", label: "settingsSources.fields.configPath", kind: "text" },
					{ key: "root", label: "settingsSources.fields.root", kind: "text" },
					{ key: "workspacePath", label: "settingsSources.fields.workspacePath", kind: "text" },
					{ key: "timeoutMs", label: "settingsSources.fields.timeoutMs", kind: "number" },
					{ key: "maxBufferBytes", label: "settingsSources.fields.maxBufferBytes", kind: "number" },
					{ key: "env", label: "settingsSources.fields.env", kind: "env", hint: "settingsSources.fields.hint.envSimple" },
				],
			},
		],
	},
	{
		id: "clawgallery",
		label: "ClawGallery",
		binary: "clawgallery",
		summary: "settingsSources.templates.clawgallery.summary",
		channels: "both",
		polling: true,
		groups: [
			{
				title: "settingsSources.groups.clawGallery",
				fields: [
					{ key: "path", label: "settingsSources.fields.vaultPath", kind: "text" },
					{ key: "configDir", label: "settingsSources.fields.configDir", kind: "text" },
					{ key: "defaultMode", label: "settingsSources.fields.defaultMode", kind: "select", options: ["hybrid", "keyword", "lexical", "embedding"] },
					{ key: "vdrBackend", label: "settingsSources.fields.vdrBackend", kind: "select", options: ["mlx", "jina-mlx", "vsplade"] },
					{ key: "syncVisual", label: "settingsSources.fields.syncVisual", kind: "boolean", defaultValue: true, hint: "settingsSources.fields.hint.defaultOn" },
				],
			},
			{
				title: "settingsSources.groups.advancedRuntime",
				fields: [
					{ key: "binaryPath", label: "settingsSources.fields.binaryPath", kind: "text" },
					{ key: "timeoutMs", label: "settingsSources.fields.timeoutMs", kind: "number" },
					{ key: "maxBufferBytes", label: "settingsSources.fields.maxBufferBytes", kind: "number" },
					{ key: "env", label: "settingsSources.fields.env", kind: "env", hint: "settingsSources.fields.hint.envSimple" },
				],
			},
		],
	},
	{
		id: "notion",
		label: "Notion",
		binary: "notcrawl",
		summary: "settingsSources.templates.notion.summary",
		channels: "both",
		polling: true,
		groups: [{ title: "settingsSources.groups.notion", fields: [] }, CRAWLER_ADVANCED],
	},
	{
		id: "lark",
		label: "Lark",
		binary: "lark-cli",
		summary: "settingsSources.templates.lark.summary",
		channels: "ids",
		polling: false,
		groups: [
			{
				title: "settingsSources.groups.lark",
				fields: [
					{ key: "binaryPath", label: "settingsSources.fields.binaryPath", kind: "text" },
					{ key: "embedderBaseUrl", label: "settingsSources.fields.embedderBaseUrl", kind: "text" },
				],
			},
		],
	},
	{
		id: "kakao",
		label: "KakaoTalk",
		binary: "lazykatok",
		summary: "settingsSources.templates.kakao.summary",
		channels: "both",
		polling: true,
		groups: [
			{
				title: "settingsSources.groups.kakao",
				fields: [
					{ key: "configPath", label: "settingsSources.fields.configPath", kind: "text" },
					{ key: "workspacePath", label: "settingsSources.fields.dataDir", kind: "text" },
					{ key: "source", label: "settingsSources.fields.sourceAdapter", kind: "text", placeholder: "macos" },
				],
			},
			{
				title: "settingsSources.groups.advancedRuntime",
				fields: [
					{ key: "binaryPath", label: "settingsSources.fields.binaryPath", kind: "text" },
					{ key: "timeoutMs", label: "settingsSources.fields.searchTimeoutMs", kind: "number" },
					{ key: "indexTimeoutMs", label: "settingsSources.fields.indexTimeoutMs", kind: "number" },
					{ key: "maxBufferBytes", label: "settingsSources.fields.maxBufferBytes", kind: "number" },
					{ key: "env", label: "settingsSources.fields.env", kind: "env", hint: "settingsSources.fields.hint.envSimple" },
				],
			},
		],
	},
	{
		id: "github",
		label: "GitHub",
		binary: null,
		summary: "settingsSources.templates.github.summary",
		channels: "both",
		polling: true,
		groups: [
			{
				title: "settingsSources.groups.github",
				fields: [
					{ key: "repos", label: "settingsSources.fields.repos", kind: "stringList", placeholder: "owner/repo" },
					{ key: "tokenEnv", label: "settingsSources.fields.tokenEnv", kind: "text", placeholder: "GITHUB_TOKEN", hint: "settingsSources.fields.hint.tokenEnv" },
					{ key: "baseUrl", label: "settingsSources.fields.baseUrl", kind: "text", placeholder: "https://api.github.com" },
				],
			},
			{
				title: "settingsSources.groups.advanced",
				fields: [
					{ key: "timeoutMs", label: "settingsSources.fields.timeoutMs", kind: "number" },
					{ key: "maxPages", label: "settingsSources.fields.maxPages", kind: "number" },
					{ key: "maxDocuments", label: "settingsSources.fields.maxDocuments", kind: "number" },
				],
			},
		],
	},
	{
		id: "github-gist",
		label: "GitHub Gist",
		binary: null,
		summary: "settingsSources.templates.githubGist.summary",
		channels: "both",
		polling: true,
		groups: [
			{
				title: "settingsSources.groups.githubGist",
				fields: [
					{ key: "tokenEnv", label: "settingsSources.fields.tokenEnv", kind: "text", placeholder: "GITHUB_TOKEN", hint: "settingsSources.fields.hint.tokenEnv" },
					{ key: "ghCliFallback", label: "settingsSources.fields.ghCliFallback", kind: "boolean", defaultValue: true, hint: "settingsSources.fields.hint.defaultOn" },
					{ key: "baseUrl", label: "settingsSources.fields.baseUrl", kind: "text", placeholder: "https://api.github.com" },
				],
			},
			{
				title: "settingsSources.groups.advanced",
				fields: [
					{ key: "statePath", label: "settingsSources.fields.statePath", kind: "text" },
					{ key: "timeoutMs", label: "settingsSources.fields.timeoutMs", kind: "number" },
					{ key: "maxPages", label: "settingsSources.fields.maxPages", kind: "number" },
					{ key: "maxGists", label: "settingsSources.fields.maxGists", kind: "number" },
				],
			},
		],
	},
	{
		id: "cloud-drive",
		label: "Cloud Drive",
		binary: "rclone",
		summary: "settingsSources.templates.cloudDrive.summary",
		channels: "both",
		polling: true,
		groups: [
			{
				title: "settingsSources.groups.cloudDrive",
				fields: [
					{ key: "provider", label: "settingsSources.fields.provider", kind: "text", placeholder: "google-drive" },
					{ key: "remote", label: "settingsSources.fields.remote", kind: "text" },
					{ key: "configPath", label: "settingsSources.fields.rcloneConfigPath", kind: "text", hint: "settingsSources.fields.hint.rcloneConfig" },
				],
			},
			{
				title: "settingsSources.groups.contentScope",
				fields: [
					{ key: "extensions", label: "settingsSources.fields.extensions", kind: "stringList", placeholder: ".md" },
					{ key: "include", label: "settingsSources.fields.includeGlob", kind: "stringList" },
					{ key: "exclude", label: "settingsSources.fields.excludeGlob", kind: "stringList" },
					{ key: "exportFormats", label: "settingsSources.fields.exportFormats", kind: "text", placeholder: "txt,csv" },
					{ key: "maxDocuments", label: "settingsSources.fields.maxDocuments", kind: "number" },
					{ key: "maxBytesPerFile", label: "settingsSources.fields.maxBytesPerFile", kind: "number" },
					{ key: "maxContentChars", label: "settingsSources.fields.maxContentChars", kind: "number" },
					{ key: "concurrency", label: "settingsSources.fields.concurrency", kind: "number" },
					{ key: "bandwidthLimit", label: "settingsSources.fields.bandwidthLimit", kind: "text" },
					{ key: "dryRun", label: "settingsSources.fields.dryRun", kind: "boolean", defaultValue: false, hint: "settingsSources.fields.hint.defaultOff" },
				],
			},
			{
				title: "settingsSources.groups.parserLanguages",
				fields: [
					{ key: "parserOptions.languages", label: "settingsSources.fields.docLanguages", kind: "stringList", placeholder: "ko" },
					{ key: "parserOptions.kordoc.ocr", label: "settingsSources.fields.kordocOcr", kind: "select", options: ["off", "force"], optionValues: { off: false, force: "force" } },
				],
			},
			{
				title: "settingsSources.groups.advancedRuntime",
				fields: [
					{ key: "binaryPath", label: "settingsSources.fields.rcloneBinaryPath", kind: "text" },
					{ key: "timeoutMs", label: "settingsSources.fields.timeoutMs", kind: "number" },
				],
			},
		],
	},
	{
		id: "mailcrawl",
		label: "Mail",
		binary: "mailcrawl",
		summary: "settingsSources.templates.mailcrawl.summary",
		channels: "both",
		polling: true,
		groups: [
			{
				title: "settingsSources.groups.mail",
				fields: [
					{ key: "account", label: "settingsSources.fields.account", kind: "text", placeholder: "gmail" },
					{ key: "mailbox", label: "settingsSources.fields.mailbox", kind: "text", placeholder: "INBOX" },
					{ key: "dataDir", label: "settingsSources.fields.dataDir", kind: "text" },
					{ key: "backend", label: "settingsSources.fields.backend", kind: "text" },
					{ key: "source", label: "settingsSources.fields.source", kind: "text" },
					{ key: "paths", label: "settingsSources.fields.mailPaths", kind: "pathList" },
					{ key: "fixture", label: "settingsSources.fields.fixture", kind: "text" },
					{ key: "himalayaConfig", label: "settingsSources.fields.himalayaConfig", kind: "text" },
					{ key: "concurrency", label: "settingsSources.fields.concurrency", kind: "number" },
				],
			},
			{
				title: "settingsSources.groups.advancedRuntime",
				fields: [
					{ key: "binaryPath", label: "settingsSources.fields.binaryPath", kind: "text" },
					{ key: "timeoutMs", label: "settingsSources.fields.searchTimeoutMs", kind: "number" },
					{ key: "indexTimeoutMs", label: "settingsSources.fields.indexTimeoutMs", kind: "number" },
					{ key: "maxBufferBytes", label: "settingsSources.fields.maxBufferBytes", kind: "number" },
					{ key: "env", label: "settingsSources.fields.env", kind: "env", hint: "settingsSources.fields.hint.envSimple" },
				],
			},
		],
	},
	{
		id: "obsidian",
		label: "Obsidian",
		binary: null,
		summary: "settingsSources.templates.obsidian.summary",
		channels: "both",
		polling: true,
		groups: [
			{
				title: "settingsSources.groups.obsidian",
				fields: [
					{ key: "vaultPath", label: "settingsSources.fields.vaultPath", kind: "text" },
				],
			},
		],
	},
	{
		id: "rss",
		label: "RSS / News",
		binary: null,
		summary: "settingsSources.templates.rss.summary",
		channels: "both",
		polling: true,
		groups: [
			{
				title: "settingsSources.groups.rss",
				fields: [
					{ key: "feeds", label: "settingsSources.fields.feeds", kind: "feeds" },
					{ key: "maxItemsPerFeed", label: "settingsSources.fields.maxItemsPerFeed", kind: "number" },
					{ key: "maxDocuments", label: "settingsSources.fields.maxDocuments", kind: "number" },
					{ key: "maxContentChars", label: "settingsSources.fields.maxContentChars", kind: "number" },
					{ key: "timeoutMs", label: "settingsSources.fields.timeoutMs", kind: "number" },
				],
			},
		],
	},
	{
		id: "hister",
		label: "Hister",
		binary: "hister",
		summary: "settingsSources.templates.hister.summary",
		channels: "none",
		polling: false,
		groups: [
			{
				title: "settingsSources.groups.hister",
				fields: [
					{ key: "baseUrl", label: "settingsSources.fields.baseUrl", kind: "text", placeholder: "http://127.0.0.1:4433" },
					{ key: "tokenEnv", label: "settingsSources.fields.tokenEnv", kind: "text", placeholder: "HISTER_TOKEN", hint: "settingsSources.fields.hint.tokenEnv" },
					{ key: "semantic", label: "settingsSources.fields.semantic", kind: "boolean", defaultValue: false, hint: "settingsSources.fields.hint.histerSemantic" },
					{ key: "timeoutMs", label: "settingsSources.fields.timeoutMs", kind: "number" },
				],
			},
		],
	},
	{
		id: "calendar",
		label: "Apple Calendar & Reminders",
		binary: "npx",
		summary: "settingsSources.templates.calendar.summary",
		channels: "none",
		polling: false,
		groups: [
			{
				title: "settingsSources.groups.calendar",
				fields: [
					{ key: "requireWriteConfirmation", label: "settingsSources.fields.requireWriteConfirmation", kind: "boolean", defaultValue: true, hint: "settingsSources.fields.hint.requireWriteConfirmation" },
					{ key: "exposure", label: "settingsSources.fields.mcpExposure", kind: "select", options: ["codemode", "direct", "deferred", "hidden"], hint: "settingsSources.fields.hint.mcpExposure" },
					{ key: "command", label: "settingsSources.fields.command", kind: "text", placeholder: "npx", hint: "settingsSources.fields.hint.calendarCommand" },
					{ key: "args", label: "settingsSources.fields.args", kind: "stringList", placeholder: "-y" },
				],
			},
		],
	},
	{
		id: "spotlight",
		label: "Spotlight",
		binary: "mdfind",
		summary: "settingsSources.templates.spotlight.summary",
		channels: "none",
		polling: false,
		groups: [
			{
				title: "settingsSources.groups.spotlight",
				fields: [
					{ key: "queries", label: "settingsSources.fields.queries", kind: "stringList", placeholder: "kMDItemContentType == 'public.plain-text'" },
					{ key: "onlyIn", label: "settingsSources.fields.onlyIn", kind: "text" },
				],
			},
			{
				title: "settingsSources.groups.advanced",
				fields: [
					{ key: "maxResultsPerQuery", label: "settingsSources.fields.maxResultsPerQuery", kind: "number" },
					{ key: "maxDocuments", label: "settingsSources.fields.maxDocuments", kind: "number" },
					{ key: "maxContentChars", label: "settingsSources.fields.maxContentChars", kind: "number" },
					{ key: "maxBytesPerFile", label: "settingsSources.fields.maxBytesPerFile", kind: "number" },
					{ key: "timeoutMs", label: "settingsSources.fields.timeoutMs", kind: "number" },
				],
			},
		],
	},
];

export const TEMPLATE_BY_ID: Readonly<Record<string, TemplateMeta>> = Object.fromEntries(TEMPLATES.map((template) => [template.id, template]));

/* -------------------------------------------------------- shared constants -- */

/** Redaction sentinel the main process substitutes for persisted secrets. */
const REDACTED_SECRET = "__AUTORAG_SECRET_REDACTED__";
/** Mirrors the main process secret-key heuristic (env/name suffixes excluded). */
const SECRET_KEY = /(?:api[-_]?key|token|password|secret|cookie|authorization|private[-_]?key)/iu;
const SECRET_NAME_SUFFIX = /(?:env|name)$/iu;

const CONTROL_INPUT: React.CSSProperties = {
	width: "100%",
	boxSizing: "border-box",
};
const ROW_STACK: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--space-6)" };
const HINT_TEXT: React.CSSProperties = { fontSize: "var(--font-size-badge)", color: "var(--text-faint)", lineHeight: 1.4 };

/* ---------------------------------------------------------------- helpers -- */

function clone<T>(value: T): T {
	return structuredClone(value);
}

function asRecord(value: unknown): Record<string, unknown> {
	return isJsonObject(value) ? (value as Record<string, unknown>) : {};
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/* -------------------------------------------------------------- editors -- */

export function ConnectorFieldInput({ field, value, onChange }: { readonly field: FieldSpec; readonly value: unknown; readonly onChange: (value: unknown) => void }): ReactElement {
	const { t } = useTranslation();
	switch (field.kind) {
		case "number":
			return (
				<input
					type="number"
					className="settings-source-desc__input"
					aria-label={t(field.label)}
					value={typeof value === "number" ? String(value) : ""}
					onChange={(event) => {
						const parsed = Number(event.target.value);
						onChange(event.target.value.length === 0 || !Number.isFinite(parsed) ? undefined : parsed);
					}}
				/>
			);
		case "select": {
			const options = field.options ?? [];
			const optionValues = field.optionValues;
			const current =
				optionValues !== undefined
					? (Object.entries(optionValues).find(([, stored]) => JSON.stringify(stored) === JSON.stringify(value))?.[0] ?? "")
					: typeof value === "string"
						? value
						: "";
			return (
				<select
					className="linear-select"
					style={CONTROL_INPUT}
					aria-label={t(field.label)}
					value={current}
					onChange={(event) => {
						const label = event.target.value;
						if (optionValues !== undefined) onChange(label.length === 0 ? undefined : optionValues[label]);
						else onChange(label.length === 0 ? undefined : label);
					}}
				>
					<option value="">{t("settingsSources.fields.defaultOption")}</option>
					{options.map((option) => (
						<option key={option} value={option}>
							{option}
						</option>
					))}
					{current.length > 0 && !options.includes(current) ? <option value={current}>{current}</option> : null}
				</select>
			);
		}
		case "stringList":
		case "pathList":
			return (
				<ListEditor
					value={asStringArray(value)}
					onChange={(next) => onChange(next.length === 0 ? undefined : next)}
					ariaLabel={t(field.label)}
					{...(field.placeholder === undefined ? {} : { placeholder: field.placeholder })}
				/>
			);
		case "feeds":
			return <FeedsEditor value={value} onChange={onChange} />;
		case "env":
			return <EnvEditor value={value} onChange={onChange} />;
		default:
			return (
				<input
					className="settings-source-desc__input"
					aria-label={t(field.label)}
					value={typeof value === "string" ? value : ""}
					placeholder={field.placeholder}
					onChange={(event) => onChange(event.target.value.length === 0 ? undefined : event.target.value)}
				/>
			);
	}
}

function ListEditor({
	value,
	onChange,
	placeholder,
	ariaLabel,
}: {
	readonly value: readonly string[];
	readonly onChange: (next: string[]) => void;
	readonly placeholder?: string;
	readonly ariaLabel?: string;
}): ReactElement {
	const { t } = useTranslation();
	return (
		<div style={ROW_STACK}>
			{value.map((item, index) => (
				<div key={index} style={{ display: "flex", gap: "var(--space-6)" }}>
					<input
						className="settings-source-desc__input"
						aria-label={ariaLabel === undefined ? undefined : t("settingsSources.fields.list.itemAt", { label: ariaLabel, index: index + 1 })}
						value={item}
						{...(placeholder === undefined ? {} : { placeholder })}
						onChange={(event) => {
							const next = value.slice();
							next[index] = event.target.value;
							onChange(next);
						}}
					/>
					<button
						type="button"
						className="linear-btn"
						aria-label={ariaLabel === undefined ? t("settingsSources.fields.list.removeItem") : t("settingsSources.fields.list.removeItemAt", { label: ariaLabel, index: index + 1 })}
						onClick={() => onChange(value.filter((_, i) => i !== index))}
					>
						–
					</button>
				</div>
			))}
			<button type="button" className="linear-btn" aria-label={ariaLabel === undefined ? t("settingsSources.fields.list.addItem") : t("settingsSources.fields.list.addItemWith", { label: ariaLabel })} onClick={() => onChange([...value, ""])}>
				{t("settingsSources.fields.list.addLabel")}
			</button>
		</div>
	);
}

interface FeedRow {
	readonly id: number;
	readonly record: Record<string, unknown>;
}


function feedRows(value: unknown, counter: { current: number }): FeedRow[] {
	if (!Array.isArray(value)) return [];
	return value.filter(isJsonObject).map((feed) => {
		counter.current += 1;
		return { id: counter.current, record: clone(feed as Record<string, unknown>) };
	});
}


function FeedsEditor({ value, onChange }: { readonly value: unknown; readonly onChange: (next: unknown) => void }): ReactElement {
	const { t } = useTranslation();
	const idRef = useRef(0);
	const [rows, setRows] = useState<FeedRow[]>(() => feedRows(value, idRef));
	const lastEmitted = useRef<string | null>(null);

	useEffect(() => {
		// Re-sync only when the stored feeds differ from what we last emitted
		// (load/reset or an external edit); in-progress rows must survive.
		if (JSON.stringify(value ?? null) === lastEmitted.current) return;
		setRows(feedRows(value, idRef));
	}, [value]);

	const apply = (next: FeedRow[]): void => {
		setRows(next);
		const cleaned = next
			.map((row) => {
				const record = clone(row.record);
				const url = typeof record.url === "string" ? record.url : "";
				const category = typeof record.category === "string" ? record.category : "";
				if (url.length > 0) record.url = url;
				else delete record.url;
				if (category.length > 0) record.category = category;
				else delete record.category;
				return record;
			})
			.filter((record) => Object.keys(record).length > 0);
		const emitted = cleaned.length === 0 ? undefined : cleaned;
		lastEmitted.current = JSON.stringify(emitted ?? null);
		onChange(emitted);
	};

	const setFeedField = (index: number, key: "url" | "category", next: string): void => {
		apply(
			rows.map((row, i) => {
				if (i !== index) return row;
				const record = clone(row.record);
				if (next.length > 0) record[key] = next;
				else delete record[key];
				return { ...row, record };
			}),
		);
	};

	return (
		<div style={ROW_STACK}>
			{rows.map((row, index) => (
				<div key={row.id} style={{ display: "flex", gap: "var(--space-6)" }}>
					<input
						className="settings-source-desc__input"
						aria-label={t("settingsSources.fields.feedsAria.urlAria", { index: index + 1 })}
						placeholder="https://example.com/feed.xml"
						value={typeof row.record.url === "string" ? row.record.url : ""}
						onChange={(event) => setFeedField(index, "url", event.target.value)}
					/>
					<input
						className="settings-source-desc__input"
						aria-label={t("settingsSources.fields.feedsAria.categoryAria", { index: index + 1 })}
						placeholder="category"
						style={{ maxWidth: 140 }}
						value={typeof row.record.category === "string" ? row.record.category : ""}
						onChange={(event) => setFeedField(index, "category", event.target.value)}
					/>
					<button
						type="button"
						className="linear-btn"
						aria-label={t("settingsSources.fields.feedsAria.removeAt", { index: index + 1 })}
						onClick={() => apply(rows.filter((_, i) => i !== index))}
					>
						–
					</button>
				</div>
			))}
			<button
				type="button"
				className="linear-btn"
				aria-label={t("settingsSources.fields.feedsAria.addAria")}
				onClick={() => apply([...rows, { id: (idRef.current += 1), record: {} }])}
			>
				{t("settingsSources.fields.feedsAria.addLabel")}
			</button>
		</div>
	);
}

const ENV_ERROR_KEYS = {
	object: "settingsSources.fields.envError.object",
	string: "settingsSources.fields.envError.string",
	secret: "settingsSources.fields.envError.secret",
	json: "settingsSources.fields.envError.json",
} as const;

interface EnvError {
	readonly key: (typeof ENV_ERROR_KEYS)[keyof typeof ENV_ERROR_KEYS];
	readonly name?: string;
}

function EnvEditor({ value, onChange }: { readonly value: unknown; readonly onChange: (next: unknown) => void }): ReactElement {
	const { t } = useTranslation();
	const record = asRecord(value);
	const [text, setText] = useState(() => JSON.stringify(record, null, 2));
	const [error, setError] = useState<EnvError | null>(null);

	useEffect(() => {
		setText(JSON.stringify(record, null, 2));
		setError(null);
		// Re-sync when the stored object identity changes (load/reset), not on every keystroke.
	}, [value]);

	function update(next: string): void {
		setText(next);
		if (next.trim().length === 0) {
			setError(null);
			onChange(undefined);
			return;
		}
		try {
			const parsed: unknown = JSON.parse(next);
			if (!isJsonObject(parsed)) {
				setError({ key: ENV_ERROR_KEYS.object });
				return;
			}
			const bad = Object.entries(parsed).find(([, child]) => child !== undefined && typeof child !== "string");
			if (bad !== undefined) {
				setError({ key: ENV_ERROR_KEYS.string, name: bad[0] });
				return;
			}
			const secret = Object.entries(parsed).find(
				([key, child]) => SECRET_KEY.test(key) && !SECRET_NAME_SUFFIX.test(key) && typeof child === "string" && child.length > 0 && child !== REDACTED_SECRET,
			);
			setError(secret === undefined ? null : { key: "settingsSources.fields.envError.secret", name: secret[0] });
			onChange(parsed);
		} catch {
			setError({ key: ENV_ERROR_KEYS.json });
		}
	}

	return (
		<div style={ROW_STACK}>
			<textarea
				className="settings-source-desc__input"
				rows={5}
				style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
				aria-label={t("settingsSources.fields.envAria")}
				value={text}
				onChange={(event) => update(event.target.value)}
			/>
			<span style={HINT_TEXT}>{t("settingsSources.fields.envEditorHint")}</span>
			{error !== null ? (
				<span style={{ ...HINT_TEXT, color: "var(--danger-text)" }} role="alert">
					{t(error.key, { name: error.name ?? "" })}
				</span>
			) : null}
		</div>
	);
}
