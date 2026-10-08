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
import { isJsonObject } from "../../../../shared/settings-contract";

/* ------------------------------------------------------------- field schema -- */

export type FieldKind = "text" | "number" | "boolean" | "select" | "stringList" | "pathList" | "env" | "feeds";

export interface FieldSpec {
	readonly key: string;
	readonly label: string;
	readonly kind: FieldKind;
	readonly hint?: string;
	readonly placeholder?: string;
	readonly options?: readonly string[];
	/** Maps select labels to stored JSON values (e.g. label "off" → false). */
	readonly optionValues?: Readonly<Record<string, unknown>>;
	/** Effective factory default for a boolean leaf when the key is absent. */
	readonly defaultValue?: boolean;
}

export interface FieldGroup {
	readonly title: string;
	readonly fields: readonly FieldSpec[];
}

export interface TemplateMeta {
	readonly id: string;
	readonly label: string;
	readonly binary: string | null;
	readonly summary: string;
	/** Which channel allowlists this template's factory forwards. */
	readonly channels: "none" | "ids" | "both";
	/** Whether the factory forwards `pollingIntervalMs`. */
	readonly polling: boolean;
	readonly groups: readonly FieldGroup[];
}

/** Shared advanced block for crawler-CLI templates (`CrawlerCliOptions`). */

const CRAWLER_ADVANCED: FieldGroup = {
	title: "고급 · 실행 환경",
	fields: [
		{ key: "binaryPath", label: "실행 파일 경로", kind: "text", hint: "비우면 PATH에서 찾습니다." },
		{ key: "databasePath", label: "데이터베이스 경로", kind: "text" },
		{ key: "sourcePath", label: "소스 경로", kind: "text" },
		{ key: "configPath", label: "설정 파일 경로", kind: "text", hint: "직접 지정한 네이티브 설정은 AutoRAG가 고쳐 쓰지 않습니다." },
		{ key: "syncSource", label: "동기화 소스", kind: "text" },
		{ key: "timeoutMs", label: "검색 타임아웃 (ms)", kind: "number" },
		{ key: "indexTimeoutMs", label: "인덱싱 타임아웃 (ms)", kind: "number" },
		{ key: "maxBufferBytes", label: "최대 버퍼 (bytes)", kind: "number" },
		{ key: "env", label: "환경 변수", kind: "env", hint: "자식 프로세스에 주입할 환경 변수입니다. 비밀값은 OS 환경 변수로 두세요." },
	],
} as FieldGroup;

export const TEMPLATES: readonly TemplateMeta[] = [
	{
		id: "telegram",
		label: "Telegram",
		binary: "telecrawl",
		summary: "telecrawl 보관함에서 Telegram 메시지를 검색합니다.",
		channels: "both",
		polling: true,
		groups: [{ title: "Telegram (telecrawl)", fields: [] }, CRAWLER_ADVANCED],
	},
	{
		id: "whatsapp",
		label: "WhatsApp",
		binary: "wacrawl",
		summary: "wacrawl 보관함에서 WhatsApp 메시지를 검색합니다.",
		channels: "both",
		polling: true,
		groups: [{ title: "WhatsApp (wacrawl)", fields: [] }, CRAWLER_ADVANCED],
	},
	{
		id: "slack",
		label: "Slack",
		binary: "slacrawl",
		summary: "slacrawl 보관함에서 Slack 메시지를 검색합니다.",
		channels: "both",
		polling: true,
		groups: [
			{ title: "Slack (slacrawl)", fields: [{ key: "workspace", label: "워크스페이스 id", kind: "text", placeholder: "T0435JHH63Z", hint: "slacrawl 검색은 워크스페이스를 지정해야 결과가 나옵니다." }] },
			CRAWLER_ADVANCED,
		],
	},
	{
		id: "discord",
		label: "Discord",
		binary: "discrawl",
		summary: "discrawl 보관함에서 Discord 메시지를 검색합니다.",
		channels: "both",
		polling: true,
		groups: [
			{
				title: "Discord (discrawl)",
				fields: [
					{ key: "guildId", label: "길드 id", kind: "text" },
					{ key: "defaultMode", label: "기본 검색 모드", kind: "select", options: ["hybrid", "fts", "semantic"] },
					{ key: "embeddingProvider", label: "임베딩 제공자", kind: "text", hint: "discrawl 네이티브 설정에 쓰이는 제공자." },
					{ key: "embeddingModel", label: "임베딩 모델", kind: "text", hint: "discrawl 네이티브 설정에 쓰이는 모델." },
					{ key: "embedLimit", label: "임베딩 최대 개수", kind: "number" },
				],
			},
			{
				title: "고급 · 실행 환경",
				fields: [
					{ key: "binaryPath", label: "실행 파일 경로", kind: "text" },
					{ key: "configPath", label: "설정 파일 경로", kind: "text" },
					{ key: "root", label: "루트 경로", kind: "text" },
					{ key: "workspacePath", label: "작업 디렉터리", kind: "text" },
					{ key: "timeoutMs", label: "타임아웃 (ms)", kind: "number" },
					{ key: "maxBufferBytes", label: "최대 버퍼 (bytes)", kind: "number" },
					{ key: "env", label: "환경 변수", kind: "env", hint: "비밀값은 OS 환경 변수로 두세요." },
				],
			},
		],
	},
	{
		id: "clawgallery",
		label: "ClawGallery",
		binary: "clawgallery",
		summary: "clawgallery 이미지 보관함을 검색합니다.",
		channels: "both",
		polling: true,
		groups: [
			{
				title: "ClawGallery",
				fields: [
					{ key: "path", label: "보관함 경로", kind: "text" },
					{ key: "configDir", label: "설정 디렉터리", kind: "text" },
					{ key: "defaultMode", label: "기본 검색 모드", kind: "select", options: ["hybrid", "keyword", "lexical", "embedding"] },
					{ key: "vdrBackend", label: "VDR 백엔드", kind: "select", options: ["mlx", "jina-mlx", "vsplade"] },
					{ key: "syncVisual", label: "시각 데이터 동기화", kind: "boolean", defaultValue: true, hint: "기본값: 켜짐." },
				],
			},
			{
				title: "고급 · 실행 환경",
				fields: [
					{ key: "binaryPath", label: "실행 파일 경로", kind: "text" },
					{ key: "timeoutMs", label: "타임아웃 (ms)", kind: "number" },
					{ key: "maxBufferBytes", label: "최대 버퍼 (bytes)", kind: "number" },
					{ key: "env", label: "환경 변수", kind: "env", hint: "비밀값은 OS 환경 변수로 두세요." },
				],
			},
		],
	},
	{
		id: "notion",
		label: "Notion",
		binary: "notcrawl",
		summary: "notcrawl 보관함에서 Notion 문서를 검색합니다.",
		channels: "both",
		polling: true,
		groups: [{ title: "Notion (notcrawl)", fields: [] }, CRAWLER_ADVANCED],
	},
	{
		id: "lark",
		label: "Lark",
		binary: "lark-cli",
		summary: "lark-cli로 Lark 메시지와 문서를 검색합니다.",
		channels: "ids",
		polling: false,
		groups: [
			{
				title: "Lark (lark-cli)",
				fields: [
					{ key: "binaryPath", label: "실행 파일 경로", kind: "text" },
					{ key: "embedderBaseUrl", label: "임베더 base URL", kind: "text" },
				],
			},
		],
	},
	{
		id: "kakao",
		label: "KakaoTalk",
		binary: "lazykatok",
		summary: "lazykatok 보관함에서 KakaoTalk 메시지를 검색합니다.",
		channels: "both",
		polling: true,
		groups: [
			{
				title: "KakaoTalk (lazykatok)",
				fields: [
					{ key: "configPath", label: "설정 파일 경로", kind: "text" },
					{ key: "workspacePath", label: "데이터 디렉터리", kind: "text" },
					{ key: "source", label: "소스 어댑터", kind: "text", placeholder: "macos" },
				],
			},
			{
				title: "고급 · 실행 환경",
				fields: [
					{ key: "binaryPath", label: "실행 파일 경로", kind: "text" },
					{ key: "timeoutMs", label: "검색 타임아웃 (ms)", kind: "number" },
					{ key: "indexTimeoutMs", label: "인덱싱 타임아웃 (ms)", kind: "number" },
					{ key: "maxBufferBytes", label: "최대 버퍼 (bytes)", kind: "number" },
					{ key: "env", label: "환경 변수", kind: "env", hint: "비밀값은 OS 환경 변수로 두세요." },
				],
			},
		],
	},
	{
		id: "github",
		label: "GitHub",
		binary: null,
		summary: "GitHub 이슈와 PR을 REST API로 색인합니다.",
		channels: "both",
		polling: true,
		groups: [
			{
				title: "GitHub",
				fields: [
					{ key: "repos", label: "저장소 (owner/repo)", kind: "stringList", placeholder: "owner/repo" },
					{ key: "tokenEnv", label: "토큰 환경 변수 이름", kind: "text", placeholder: "GITHUB_TOKEN", hint: "비밀 토큰 자체가 아니라, 토큰이 담긴 환경 변수 이름입니다." },
					{ key: "baseUrl", label: "REST base URL", kind: "text", placeholder: "https://api.github.com" },
				],
			},
			{
				title: "고급",
				fields: [
					{ key: "timeoutMs", label: "타임아웃 (ms)", kind: "number" },
					{ key: "maxPages", label: "최대 페이지", kind: "number" },
					{ key: "maxDocuments", label: "최대 문서 수", kind: "number" },
				],
			},
		],
	},
	{
		id: "github-gist",
		label: "GitHub Gist",
		binary: null,
		summary: "인증된 계정의 GitHub Gist를 색인합니다.",
		channels: "both",
		polling: true,
		groups: [
			{
				title: "GitHub Gist",
				fields: [
					{ key: "tokenEnv", label: "토큰 환경 변수 이름", kind: "text", placeholder: "GITHUB_TOKEN", hint: "비밀 토큰 자체가 아니라, 토큰이 담긴 환경 변수 이름입니다." },
					{ key: "ghCliFallback", label: "gh CLI 토큰 대체 사용", kind: "boolean", defaultValue: true, hint: "기본값: 켜짐." },
					{ key: "baseUrl", label: "REST base URL", kind: "text", placeholder: "https://api.github.com" },
				],
			},
			{
				title: "고급",
				fields: [
					{ key: "statePath", label: "증분 커서 경로", kind: "text" },
					{ key: "timeoutMs", label: "타임아웃 (ms)", kind: "number" },
					{ key: "maxPages", label: "최대 페이지", kind: "number" },
					{ key: "maxGists", label: "최대 Gist 수", kind: "number" },
				],
			},
		],
	},
	{
		id: "cloud-drive",
		label: "Cloud Drive",
		binary: "rclone",
		summary: "rclone 원격을 증분 미러링해 색인합니다.",
		channels: "both",
		polling: true,
		groups: [
			{
				title: "Cloud Drive (rclone)",
				fields: [
					{ key: "provider", label: "제공자", kind: "text", placeholder: "google-drive" },
					{ key: "remote", label: "원격 이름", kind: "text" },
					{ key: "configPath", label: "rclone 설정 경로", kind: "text", hint: "직접 지정한 rclone.conf는 읽기 전용으로만 씁니다." },
				],
			},
			{
				title: "콘텐츠 범위",
				fields: [
					{ key: "extensions", label: "포함 확장자", kind: "stringList", placeholder: ".md" },
					{ key: "include", label: "포함 글롭", kind: "stringList" },
					{ key: "exclude", label: "제외 글롭", kind: "stringList" },
					{ key: "exportFormats", label: "내보내기 형식", kind: "text", placeholder: "txt,csv" },
					{ key: "maxDocuments", label: "최대 문서 수", kind: "number" },
					{ key: "maxBytesPerFile", label: "파일당 최대 바이트", kind: "number" },
					{ key: "maxContentChars", label: "문서당 최대 문자", kind: "number" },
					{ key: "concurrency", label: "동시성", kind: "number" },
					{ key: "bandwidthLimit", label: "대역폭 제한", kind: "text" },
					{ key: "dryRun", label: "드라이 런", kind: "boolean", defaultValue: false, hint: "기본값: 꺼짐." },
				],
			},
			{
				title: "파서 (OCR · 문서 언어)",
				fields: [
					{ key: "parserOptions.languages", label: "문서 언어", kind: "stringList", placeholder: "ko" },
					{ key: "parserOptions.ocr.enabled", label: "OCR 사용", kind: "boolean", defaultValue: false, hint: "기본값: 꺼짐." },
					{ key: "parserOptions.ocr.languages", label: "OCR 언어", kind: "stringList", placeholder: "eng" },
					{ key: "parserOptions.ocr.timeoutMs", label: "OCR 타임아웃 (ms)", kind: "number" },
					{ key: "parserOptions.ocr.maxBytes", label: "OCR 최대 바이트", kind: "number" },
					{ key: "parserOptions.kordoc.ocr", label: "kordoc OCR", kind: "select", options: ["off", "force"], optionValues: { off: false, force: "force" } },
				],
			},
			{
				title: "고급 · 실행 환경",
				fields: [
					{ key: "binaryPath", label: "rclone 실행 파일 경로", kind: "text" },
					{ key: "timeoutMs", label: "타임아웃 (ms)", kind: "number" },
				],
			},
		],
	},
	{
		id: "mail-export",
		label: "Mail Export",
		binary: null,
		summary: "로컬 .eml / .mbox 보관 파일을 색인합니다.",
		channels: "both",
		polling: true,
		groups: [
			{
				title: "Mail Export",
				fields: [
					{ key: "paths", label: "메일 파일·디렉터리 경로", kind: "pathList" },
					{ key: "maxDocuments", label: "최대 문서 수", kind: "number" },
					{ key: "maxBytesPerFile", label: "파일당 최대 바이트", kind: "number" },
				],
			},
		],
	},
	{
		id: "mailcrawl",
		label: "Mail",
		binary: "mailcrawl",
		summary: "mailcrawl 보관함에서 메일을 검색합니다.",
		channels: "both",
		polling: true,
		groups: [
			{
				title: "Mail",
				fields: [
					{ key: "account", label: "계정", kind: "text", placeholder: "gmail" },
					{ key: "mailbox", label: "메일함", kind: "text", placeholder: "INBOX" },
					{ key: "dataDir", label: "데이터 디렉터리", kind: "text" },
					{ key: "backend", label: "백엔드", kind: "text" },
					{ key: "source", label: "소스", kind: "text" },
					{ key: "fixture", label: "픽스처", kind: "text" },
					{ key: "himalayaConfig", label: "himalaya 설정", kind: "text" },
				],
			},
			{
				title: "고급 · 실행 환경",
				fields: [
					{ key: "binaryPath", label: "실행 파일 경로", kind: "text" },
					{ key: "timeoutMs", label: "검색 타임아웃 (ms)", kind: "number" },
					{ key: "indexTimeoutMs", label: "인덱싱 타임아웃 (ms)", kind: "number" },
					{ key: "maxBufferBytes", label: "최대 버퍼 (bytes)", kind: "number" },
					{ key: "env", label: "환경 변수", kind: "env", hint: "비밀값은 OS 환경 변수로 두세요." },
				],
			},
		],
	},
	{
		id: "obsidian",
		label: "Obsidian",
		binary: "qmd",
		summary: "qmd로 Obsidian 보관함을 검색합니다.",
		channels: "both",
		polling: true,
		groups: [
			{
				title: "Obsidian (qmd)",
				fields: [
					{ key: "vaultPath", label: "보관함 경로", kind: "text" },
					{ key: "binaryPath", label: "qmd 실행 파일 경로", kind: "text" },
					{ key: "configPath", label: "설정 디렉터리", kind: "text" },
				],
			},
		],
	},
	{
		id: "rss",
		label: "RSS / News",
		binary: null,
		summary: "RSS 2.0 / Atom 피드를 폴링해 색인합니다.",
		channels: "both",
		polling: true,
		groups: [
			{
				title: "RSS / News",
				fields: [
					{ key: "feeds", label: "피드", kind: "feeds" },
					{ key: "maxItemsPerFeed", label: "피드당 최대 항목", kind: "number" },
					{ key: "maxDocuments", label: "최대 문서 수", kind: "number" },
					{ key: "maxContentChars", label: "문서당 최대 문자", kind: "number" },
					{ key: "timeoutMs", label: "타임아웃 (ms)", kind: "number" },
				],
			},
		],
	},
	{
		id: "spotlight",
		label: "Spotlight",
		binary: "mdfind",
		summary: "macOS Spotlight(mdfind) 쿼리로 로컬 파일을 색인합니다.",
		channels: "both",
		polling: true,
		groups: [
			{
				title: "Spotlight (mdfind)",
				fields: [
					{ key: "queries", label: "쿼리", kind: "stringList", placeholder: "kMDItemContentType == 'public.plain-text'" },
					{ key: "onlyIn", label: "검색 디렉터리 (-onlyin)", kind: "text" },
				],
			},
			{
				title: "고급",
				fields: [
					{ key: "maxResultsPerQuery", label: "쿼리당 최대 결과", kind: "number" },
					{ key: "maxDocuments", label: "최대 문서 수", kind: "number" },
					{ key: "maxContentChars", label: "문서당 최대 문자", kind: "number" },
					{ key: "maxBytesPerFile", label: "파일당 최대 바이트", kind: "number" },
					{ key: "timeoutMs", label: "타임아웃 (ms)", kind: "number" },
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
	switch (field.kind) {
		case "number":
			return (
				<input
					type="number"
					className="settings-source-desc__input"
					aria-label={field.label}
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
					aria-label={field.label}
					value={current}
					onChange={(event) => {
						const label = event.target.value;
						if (optionValues !== undefined) onChange(label.length === 0 ? undefined : optionValues[label]);
						else onChange(label.length === 0 ? undefined : label);
					}}
				>
					<option value="">(기본값)</option>
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
					ariaLabel={field.label}
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
					aria-label={field.label}
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
	return (
		<div style={ROW_STACK}>
			{value.map((item, index) => (
				<div key={index} style={{ display: "flex", gap: "var(--space-6)" }}>
					<input
						className="settings-source-desc__input"
						aria-label={ariaLabel === undefined ? undefined : `${ariaLabel} ${index + 1}`}
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
						aria-label={ariaLabel === undefined ? "항목 삭제" : `${ariaLabel} ${index + 1} 삭제`}
						onClick={() => onChange(value.filter((_, i) => i !== index))}
					>
						–
					</button>
				</div>
			))}
			<button type="button" className="linear-btn" aria-label={ariaLabel === undefined ? "항목 추가" : `${ariaLabel} 추가`} onClick={() => onChange([...value, ""])}>
				+ 항목 추가
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
						aria-label={`피드 URL ${index + 1}`}
						placeholder="https://example.com/feed.xml"
						value={typeof row.record.url === "string" ? row.record.url : ""}
						onChange={(event) => setFeedField(index, "url", event.target.value)}
					/>
					<input
						className="settings-source-desc__input"
						aria-label={`피드 카테고리 ${index + 1}`}
						placeholder="category"
						style={{ maxWidth: 140 }}
						value={typeof row.record.category === "string" ? row.record.category : ""}
						onChange={(event) => setFeedField(index, "category", event.target.value)}
					/>
					<button
						type="button"
						className="linear-btn"
						aria-label={`피드 ${index + 1} 삭제`}
						onClick={() => apply(rows.filter((_, i) => i !== index))}
					>
						–
					</button>
				</div>
			))}
			<button
				type="button"
				className="linear-btn"
				aria-label="피드 추가"
				onClick={() => apply([...rows, { id: (idRef.current += 1), record: {} }])}
			>
				+ 피드 추가
			</button>
		</div>
	);
}

function EnvEditor({ value, onChange }: { readonly value: unknown; readonly onChange: (next: unknown) => void }): ReactElement {
	const record = asRecord(value);
	const [text, setText] = useState(() => JSON.stringify(record, null, 2));
	const [error, setError] = useState<string | null>(null);

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
				setError("환경 변수는 JSON 객체여야 합니다.");
				return;
			}
			const bad = Object.entries(parsed).find(([, child]) => child !== undefined && typeof child !== "string");
			if (bad !== undefined) {
				setError(`'${bad[0]}' 값은 문자열이어야 합니다.`);
				return;
			}
			const secret = Object.entries(parsed).find(
				([key, child]) => SECRET_KEY.test(key) && !SECRET_NAME_SUFFIX.test(key) && typeof child === "string" && child.length > 0 && child !== REDACTED_SECRET,
			);
			setError(secret === undefined ? null : `'${secret[0]}' 값이 평문 비밀처럼 보여 저장이 거부됩니다. OS 환경 변수로 옮기세요.`);
			onChange(parsed);
		} catch {
			setError("올바른 JSON이 아닙니다.");
		}
	}

	return (
		<div style={ROW_STACK}>
			<textarea
				className="settings-source-desc__input"
				rows={5}
				style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
				aria-label="환경 변수 (JSON)"
				value={text}
				onChange={(event) => update(event.target.value)}
			/>
			<span style={HINT_TEXT}>자식 프로세스에 주입할 환경 변수입니다. 비밀 토큰·비밀번호는 여기 대신 OS 환경 변수로 두세요.</span>
			{error !== null ? (
				<span style={{ ...HINT_TEXT, color: "var(--danger-text)" }} role="alert">
					{error}
				</span>
			) : null}
		</div>
	);
}
