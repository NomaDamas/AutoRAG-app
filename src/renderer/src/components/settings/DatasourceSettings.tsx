/**
 * Settings > Data Sources — full source management for the shared AutoRAG
 * config.
 *
 * Every writable field of `datasources.<alias>` is exposed through named
 * controls (no raw-JSON-only editing): the generic entry fields (`type`,
 * `instanceId`, `enabled`, `description`, `pollingIntervalMs`, `tags`,
 * `channels.ids` / `channels.names`) plus the connector fields each built-in
 * template's factory actually reads. Add/rename/delete operate on individual
 * config paths so unrelated connections and unknown fields are never
 * clobbered. Read-only status (install / agent / index) comes from the live
 * `sources:list` snapshot.
 *
 * This file is self-contained: the parent mounts it and passes the freshest
 * config snapshot plus an optional `initialType` to open a template's add
 * form. Saves batch their changed leaves (including removals) through
 * `configPatch`; creates/deletes use `configSet` / `configRemove`.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { useAutoSave } from "./useAutoSave";
import type {
	AutoRagConfigSnapshot,
	AutoRagConfigUpdate,
	DataSourceRow,
	JsonValue,
	ProviderCredentialStatus,
} from "../../../../shared/settings-contract";
import { isJsonObject } from "../../../../shared/settings-contract";
import { PlusIcon, TrashIcon } from "../icons";
import { Switch } from "../primitives/Switch";

const settings = window.autorag.settings;

/**
 * Atomic config writes. Every save batches its leaf writes *and* removals into
 * one `configPatch` call; alias renames go through `configRename` (the main
 * process rejects a destination collision).
 */

/** Redaction sentinel the main process substitutes for persisted secrets. */
const REDACTED_SECRET = "__AUTORAG_SECRET_REDACTED__";
/** Mirrors the main process secret-key heuristic (env/name suffixes excluded). */
const SECRET_KEY = /(?:api[-_]?key|token|password|secret|cookie|authorization|private[-_]?key)/iu;
const SECRET_NAME_SUFFIX = /(?:env|name)$/iu;
/** Mirrors the backend path-segment guard. */
const SAFE_PATH_SEGMENT = /^(?!__proto__$|prototype$|constructor$)[^/]+$/u;

/* ------------------------------------------------------------- field schema -- */

type FieldKind = "text" | "number" | "boolean" | "select" | "stringList" | "pathList" | "env" | "feeds";

interface FieldSpec {
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

interface FieldGroup {
	readonly title: string;
	readonly fields: readonly FieldSpec[];
}

interface TemplateMeta {
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

const TEMPLATES: readonly TemplateMeta[] = [
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
		label: "Mail (mailcrawl)",
		binary: "mailcrawl",
		summary: "mailcrawl 보관함에서 메일을 검색합니다.",
		channels: "both",
		polling: true,
		groups: [
			{
				title: "Mail (mailcrawl)",
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

const TEMPLATE_BY_ID: Readonly<Record<string, TemplateMeta>> = Object.fromEntries(TEMPLATES.map((template) => [template.id, template]));

/** Template catalogue for a parent-owned sidebar/app grid. */
export const DATASOURCE_TEMPLATES: readonly { readonly id: string; readonly label: string }[] = TEMPLATES.map((template) => ({ id: template.id, label: template.label }));

const STATUS_LABELS: Record<DataSourceRow["status"], string> = {
	ready: "Ready",
	syncing: "Syncing",
	paused: "Paused",
	attention: "Needs attention",
};

const INSTALL_LABELS: Record<DataSourceRow["install"]["state"], string> = {
	installed: "설치됨",
	missing: "미설치",
	builtin: "내장",
	"credential-missing": "인증 필요",
	unsupported: "지원 안 함",
};

const AGENT_LABELS: Record<DataSourceRow["agent"]["state"], string> = {
	connected: "연동됨",
	blocked: "접근 차단",
	disabled: "꺼짐",
	unsupported: "지원 안 함",
};

const INDEX_LABELS: Record<DataSourceRow["index"]["state"], string> = {
	indexed: "인덱싱됨",
	empty: "비어 있음",
	"not-indexed": "인덱스 없음",
	external: "CLI 자체 인덱스",
};

const CONTROL_INPUT: React.CSSProperties = {
	width: "100%",
	boxSizing: "border-box",
};
const ROW_STACK: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--space-6)" };
const GROUP_STACK: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--space-10)" };
const HINT_TEXT: React.CSSProperties = { fontSize: "var(--font-size-badge)", color: "var(--text-faint)", lineHeight: 1.4 };

/* ---------------------------------------------------------------- helpers -- */

function errorText(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

/**
 * Fold fresh on-disk values into a draft without touching fields the user has
 * edited: wherever the draft still equals its baseline (untouched) the incoming
 * value wins, so external changes (an enable toggle, a concurrent save) land
 * while in-progress edits survive.
 */
function reconcileValue(draft: unknown, baseline: unknown, incoming: unknown): unknown {
	if (JSON.stringify(draft) === JSON.stringify(baseline)) return clone(incoming);
	if (isJsonObject(draft) && isJsonObject(baseline) && isJsonObject(incoming)) {
		const draftRecord = draft as Record<string, unknown>;
		const baselineRecord = baseline as Record<string, unknown>;
		const incomingRecord = incoming as Record<string, unknown>;
		const next: Record<string, unknown> = {};
		for (const key of new Set([...Object.keys(draftRecord), ...Object.keys(incomingRecord)])) {
			const hasDraft = Object.hasOwn(draftRecord, key);
			const hasBaseline = Object.hasOwn(baselineRecord, key);
			const hasIncoming = Object.hasOwn(incomingRecord, key);
			if (!hasDraft) {
				if (hasIncoming) next[key] = clone(incomingRecord[key]);
				continue;
			}
			if (!hasBaseline) {
				// The user added this key; keep their draft value.
				next[key] = draftRecord[key];
				continue;
			}
			const merged = reconcileValue(draftRecord[key], baselineRecord[key], hasIncoming ? incomingRecord[key] : undefined);
			if (merged !== undefined) next[key] = merged;
		}
		return next;
	}
	return draft;
}

function entryOf(raw: unknown): Record<string, unknown> {
	if (raw === false) return { enabled: false };
	if (raw === true) return {};
	return isJsonObject(raw) ? (raw as Record<string, unknown>) : {};
}

function typeOf(alias: string, raw: unknown): string {
	const entry = entryOf(raw);
	return typeof entry.type === "string" && entry.type.length > 0 ? entry.type : alias;
}

function asRecord(value: unknown): Record<string, unknown> {
	return isJsonObject(value) ? (value as Record<string, unknown>) : {};
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readAt(root: unknown, path: readonly string[]): unknown {
	let current: unknown = root;
	for (const segment of path) {
		if (!isJsonObject(current)) return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function withPath(root: Record<string, unknown>, path: readonly string[], value: unknown): Record<string, unknown> {
	const next = clone(root);
	let current: Record<string, unknown> = next;
	for (const segment of path.slice(0, -1)) {
		const child = current[segment];
		if (!isJsonObject(child)) current[segment] = {};
		current = current[segment] as Record<string, unknown>;
	}
	const last = path[path.length - 1];
	if (last === undefined) return next;
	current[last] = value;
	return next;
}

/** Plaintext-secret guard for the env editor: an *edited* secret-looking env value is refused. */
function envSecretProblem(env: unknown): string | null {
	if (!isJsonObject(env)) return null;
	for (const [key, value] of Object.entries(env)) {
		if (!SECRET_KEY.test(key) || SECRET_NAME_SUFFIX.test(key)) continue;
		if (typeof value === "string" && value.length > 0 && value !== REDACTED_SECRET) {
			return `'${key}' 값이 평문 비밀처럼 보입니다. OS 환경 변수로 옮기고 설정에는 남기지 마세요.`;
		}
	}
	return null;
}

/** Apply changed leaves in one atomic patch; `null` when there is nothing to write. */
async function writeChanges(ops: readonly AutoRagConfigUpdate[]): Promise<AutoRagConfigSnapshot | null> {
	if (ops.length === 0) return null;
	return settings.configPatch(ops);
}

/** Collect only the leaf paths that actually changed, so writes never clobber siblings. */
function diffValue(before: unknown, after: unknown, path: string[], out: AutoRagConfigUpdate[]): void {
	if (JSON.stringify(before) === JSON.stringify(after)) return;
	if (Array.isArray(before) && Array.isArray(after)) {
		out.push({ path: [...path], value: after as JsonValue });
		return;
	}
	if (isJsonObject(before) && isJsonObject(after)) {
		const beforeRecord = before as Record<string, unknown>;
		const afterRecord = after as Record<string, unknown>;
		const keys = new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)]);
		for (const key of keys) {
			const hasBefore = Object.hasOwn(beforeRecord, key);
			const hasAfter = Object.hasOwn(afterRecord, key);
			const b = hasBefore ? beforeRecord[key] : undefined;
			const a = hasAfter ? afterRecord[key] : undefined;
			if (!hasBefore) {
				const empty = Array.isArray(a) ? a.length === 0 : isJsonObject(a) && Object.keys(a).length === 0;
				if (a === undefined || empty) continue;
				out.push({ path: [...path, key], value: a as JsonValue });
				continue;
			}
			if (!hasAfter || a === undefined) {
				out.push({ path: [...path, key], remove: true });
				continue;
			}
			diffValue(b, a, [...path, key], out);
		}
		return;
	}
	if (after === undefined) {
		out.push({ path: [...path], remove: true });
		return;
	}
	out.push({ path: [...path], value: after as JsonValue });
}

function defaultAlias(existing: ReadonlySet<string>, templateId: string): string {
	if (!existing.has(templateId)) return templateId;
	for (let index = 2; index < 1000; index += 1) {
		const candidate = `${templateId}-${index}`;
		if (!existing.has(candidate)) return candidate;
	}
	return `${templateId}-${Date.now()}`;
}

function indexSummary(index: DataSourceRow["index"]): string {
	if (index.state === "indexed" && index.chunkCount !== null) return `${index.chunkCount.toLocaleString()} chunks`;
	return INDEX_LABELS[index.state];
}

/* -------------------------------------------------------------- component -- */

export function DatasourceSettings({
	snapshot,
	onSaved,
	initialType,
	initialAlias,
	singleConnection = false,
	overviewOnly = false,
}: {
	readonly snapshot: AutoRagConfigSnapshot;
	readonly onSaved: (snapshot: AutoRagConfigSnapshot) => void;
	readonly initialType?: string;
	/** Open one configured connection from the Settings datasource group. */
	readonly initialAlias?: string;
	/** Hide the all-connections overview and show only `initialAlias`. */
	readonly singleConnection?: boolean;
	/** Management view: add/select templates without nesting connection editors. */
	readonly overviewOnly?: boolean;
}): ReactElement {
	const [data, setData] = useState<AutoRagConfigSnapshot>(snapshot);
	const [statuses, setStatuses] = useState<DataSourceRow[] | null>(null);
	const [accessTags, setAccessTags] = useState<string[]>([]);
	const [statusError, setStatusError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [expanded, setExpanded] = useState<string | null>(null);
	const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
	const [focusedTemplate, setFocusedTemplate] = useState<string | null>(null);
	const [addTemplate, setAddTemplate] = useState<string | null>(null);
	const [addAlias, setAddAlias] = useState("");
	const [addInstanceId, setAddInstanceId] = useState("");
	const [addError, setAddError] = useState<string | null>(null);
	const initialHandled = useRef<string | null>(null);

	useEffect(() => {
		setData(snapshot);
	}, [snapshot]);

	const reloadStatus = useCallback(async (): Promise<void> => {
		try {
			const next = await settings.sourcesList();
			setStatuses([...next.sources]);
			setAccessTags([...next.accessTags]);
			setStatusError(next.error);
		} catch (error) {
			setStatusError(errorText(error));
		}
	}, []);

	useEffect(() => {
		void reloadStatus();
	}, [reloadStatus]);

const config = data.config;
	const datasources = useMemo<Record<string, unknown>>(() => asRecord(config.datasources), [config]);
	const aliases = useMemo(() => Object.keys(datasources).sort((a, b) => a.localeCompare(b)), [datasources]);
	const aliasSet = useMemo(() => new Set(aliases), [aliases]);
	const visibleAliases = useMemo(() => {
		if (initialAlias !== undefined) return aliases.includes(initialAlias) ? [initialAlias] : [];
		return focusedTemplate === null ? aliases : aliases.filter((alias) => typeOf(alias, datasources[alias]) === focusedTemplate);
	}, [aliases, datasources, focusedTemplate, initialAlias]);
	const isSingleConnection = singleConnection && initialAlias !== undefined;
	const rowById = useMemo(() => new Map((statuses ?? []).map((row) => [row.id, row])), [statuses]);
	const countsByTemplate = useMemo(() => {
		const counts = new Map<string, number>();
		for (const alias of aliases) {
			const type = typeOf(alias, datasources[alias]);
			counts.set(type, (counts.get(type) ?? 0) + 1);
		}
		return counts;
	}, [aliases, datasources]);

	const apply = useCallback(
		(next: AutoRagConfigSnapshot): void => {
			setData(next);
			onSaved(next);
		},
		[onSaved],
	);

	/** Read the freshest snapshot after a failure so the UI never shows stale config. */
	const resync = useCallback(async (): Promise<void> => {
		try {
			apply(await settings.configGet());
		} catch {
			/* keep the last good snapshot when even the resync fails */
		}
	}, [apply]);

	const setAddForm = useCallback(
		(templateId: string | null): void => {
			setAddError(null);
			if (templateId === null) {
				setAddTemplate(null);
				return;
			}
			setAddTemplate(templateId);
			setAddAlias(defaultAlias(aliasSet, templateId));
			setAddInstanceId("");
		},
		[aliasSet],
	);

	useEffect(() => {
		if (initialAlias !== undefined) {
			setExpanded(initialAlias);
			setFocusedTemplate(null);
			setAddTemplate(null);
			return;
		}
		if (initialType === undefined || initialType.length === 0) return;
		if (initialHandled.current === initialType) return;
		initialHandled.current = initialType;
		if (Object.hasOwn(TEMPLATE_BY_ID, initialType)) {
			setFocusedTemplate(initialType);
			setAddForm(initialType);
		}
	}, [initialAlias, initialType, setAddForm]);

	const addConnection = useCallback(async (): Promise<void> => {
		if (addTemplate === null) return;
		const alias = addAlias.trim();
		if (!SAFE_PATH_SEGMENT.test(alias)) {
			setAddError("연결 id에는 '/' 없이 비어 있지 않은 이름을 쓰세요.");
			return;
		}
		if (aliasSet.has(alias)) {
			setAddError(`이미 '${alias}' 연결이 있습니다. 다른 id를 쓰세요.`);
			return;
		}
		setBusy(true);
		setActionError(null);
		try {
			const fresh = await settings.configGet();
			apply(fresh);
			if (Object.hasOwn(asRecord(fresh.config.datasources), alias)) {
				setAddError(`이미 '${alias}' 연결이 있습니다. 다른 id를 쓰세요.`);
				return;
			}
			const entry: Record<string, unknown> = {};
			if (alias !== addTemplate) entry.type = addTemplate;
			const instanceId = addInstanceId.trim();
			if (instanceId.length > 0) entry.instanceId = instanceId;
			apply(await settings.configSet(["datasources", alias], entry as unknown as JsonValue));
			setExpanded(alias);
			setAddTemplate(null);
			void reloadStatus();
		} catch (error) {
			setAddError(errorText(error));
			await resync();
		} finally {
			setBusy(false);
		}
	}, [addTemplate, addAlias, addInstanceId, aliasSet, apply, reloadStatus, resync]);

	/** Commit one connection's draft against the user's own baseline, so unrelated concurrent changes stay put. */
	const commitConnection = useCallback(
		async (
			alias: string,
			baseline: Record<string, unknown>,
			draft: Record<string, unknown>,
			newAlias: string,
		): Promise<string | null> => {
			const target = newAlias.trim();
			if (!SAFE_PATH_SEGMENT.test(target)) return "연결 id에는 '/' 없이 비어 있지 않은 이름을 쓰세요.";
			if (target !== alias && Object.hasOwn(datasources, target)) return `이미 '${target}' 연결이 있습니다. 다른 id를 쓰세요.`;

			setBusy(true);
			setActionError(null);
			try {
				const ops: AutoRagConfigUpdate[] = [];
				diffValue(baseline, draft, ["datasources", alias], ops);
				if (ops.some((op) => "value" in op && op.path[op.path.length - 1] === "env")) {
					const secretProblem = envSecretProblem(asRecord(draft.connector).env);
					if (secretProblem !== null) return secretProblem;
				}

				if (target === alias) {
					if (ops.length === 0) return null;
					const next = await writeChanges(ops);
					if (next !== null) apply(next);
					void reloadStatus();
					return null;
				}

				// Rename: persist the edited entry first, then move it. The two writes are
				// separate — a rename is not atomic with the edit — but patching first is
				// safe and `configRename` rejects an id that is already taken.
				const desiredType = typeof draft.type === "string" && draft.type.length > 0 ? draft.type : alias;
				for (let index = ops.length - 1; index >= 0; index -= 1) {
					const op = ops[index];
					if (op !== undefined && op.path.length === 3 && op.path[2] === "type") ops.splice(index, 1);
				}
				if (desiredType !== target) ops.push({ path: ["datasources", alias, "type"], value: desiredType });

				const patched = await writeChanges(ops);
				if (patched !== null) apply(patched);
				const next = await settings.configRename(["datasources", alias], ["datasources", target]);
				apply(next);
				setExpanded(target);
				void reloadStatus();
				return null;
			} catch (error) {
				await resync();
				return errorText(error);
			} finally {
				setBusy(false);
			}
		},
		[datasources, apply, reloadStatus, resync],
	);

	const toggleEnabled = useCallback(
		async (alias: string, enabled: boolean): Promise<void> => {
			setBusy(true);
			setActionError(null);
			try {
				apply(await settings.configSet(["datasources", alias, "enabled"], enabled));
				void reloadStatus();
			} catch (error) {
				setActionError(errorText(error));
				await resync();
			} finally {
				setBusy(false);
			}
		},
		[apply, reloadStatus, resync],
	);

	const deleteConnection = useCallback(
		async (alias: string): Promise<void> => {
			setBusy(true);
			setActionError(null);
			try {
				apply(await settings.configRemove(["datasources", alias]));
				setConfirmDelete(null);
				if (expanded === alias) setExpanded(null);
				void reloadStatus();
			} catch (error) {
				setActionError(errorText(error));
				await resync();
			} finally {
				setBusy(false);
			}
		},
		[apply, expanded, reloadStatus, resync],
	);

	const setAccess = useCallback(
		async (nextTags: string[]): Promise<void> => {
			const unique = Array.from(new Set(nextTags));
			setBusy(true);
			setActionError(null);
			try {
				const next =
					unique.length === 0
						? await settings.configRemove(["datasourceAccess", "allowedTags"])
						: await settings.configSet(["datasourceAccess", "allowedTags"], unique);
				apply(next);
				void reloadStatus();
			} catch (error) {
				setActionError(errorText(error));
				await resync();
			} finally {
				setBusy(false);
			}
		},
		[apply, reloadStatus, resync],
	);

	const problem = actionError ?? statusError ?? data.error;

return (
		<div className="settings-datasources" role="region" aria-label={isSingleConnection ? `${initialAlias} data source` : "Data Sources"}>
			<div className="linear-header">
				<h2 className="linear-title">{isSingleConnection ? (initialAlias === undefined ? "Data Source" : `${TEMPLATE_BY_ID[typeOf(initialAlias, datasources[initialAlias])]?.label ?? typeOf(initialAlias, datasources[initialAlias])} · ${initialAlias}`) : "Data Sources"}</h2>
				<p className="linear-desc">
					{isSingleConnection
						? "변경 사항은 저장 버튼 없이 즉시 AutoRAG config.json에 반영됩니다. 인덱스 재생성이 필요한 변경은 해당 모델 설정에서만 별도로 실행합니다."
						: overviewOnly
							? "새 데이터 소스를 아래 템플릿에서 추가하세요. 기존 연결은 왼쪽 Data Sources 그룹에서 연결별 탭을 선택해 편집합니다."
							: "공유 AutoRAG 설정의 데이터 소스를 추가·편집합니다. 여기서 저장한 값은 에이전트가 읽는 동일한 config.json에 반영됩니다."}
				</p>
			</div>

			{problem !== null ? <div className="settings-error" role="alert">{problem}</div> : null}

			{!overviewOnly && !isSingleConnection && focusedTemplate !== null ? (
				<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-12)", padding: "10px var(--space-12)", marginBottom: "var(--space-8)", border: "1px solid var(--border-divider)", borderRadius: "var(--radius-8)", background: "var(--bg-subtle)" }}>
					<span style={HINT_TEXT}>{TEMPLATE_BY_ID[focusedTemplate]?.label ?? focusedTemplate} 연결 {visibleAliases.length}개만 보는 중</span>
					<span style={{ display: "flex", gap: "var(--space-6)" }}>
						<button type="button" className="linear-btn" onClick={() => { setFocusedTemplate(null); setAddForm(null); }}>모든 연결</button>
						<button type="button" className="linear-btn" onClick={() => setAddForm(focusedTemplate)}>다른 연결 추가</button>
					</span>
				</div>
			) : null}
			{overviewOnly ? (
				<p className="linear-section-desc">{aliases.length === 0 ? "아직 연결이 없습니다. 아래 템플릿 카드에서 추가하세요." : `현재 ${aliases.length}개의 연결이 있습니다. 왼쪽 Data Sources 그룹에서 편집할 연결을 선택하세요.`}</p>
			) : visibleAliases.length === 0 ? (
				<p className="linear-section-desc">{isSingleConnection ? "이 연결은 더 이상 config에 존재하지 않습니다. 왼쪽 Data Sources에서 다른 연결을 선택하세요." : aliases.length === 0 ? "아직 연결이 없습니다. 아래 템플릿 카드에서 추가하세요." : `${TEMPLATE_BY_ID[focusedTemplate ?? ""]?.label ?? focusedTemplate} 유형의 연결이 없습니다. 아래에서 추가하세요.`}</p>
			) : (
				<div className="provider-list">
					{visibleAliases.map((alias) => (
						<ConnectionCard
							key={alias}
							alias={alias}
							raw={datasources[alias]}
							row={rowById.get(alias)}
							allowedTags={accessTags}
							busy={busy}
							expanded={isSingleConnection || expanded === alias}
							confirmingDelete={confirmDelete === alias}
							onToggleExpanded={() => setExpanded((current) => (current === alias ? null : alias))}
							onToggleEnabled={(enabled) => void toggleEnabled(alias, enabled)}
							onRequestDelete={() => setConfirmDelete(alias)}
							onCancelDelete={() => setConfirmDelete(null)}
							onConfirmDelete={() => void deleteConnection(alias)}
							onCommit={(draft, baseline, newAlias) => commitConnection(alias, baseline, draft, newAlias)}
							onSetAccess={(tags) => void setAccess(tags)}
							onDismissError={() => setActionError(null)}
						/>
					))}
				</div>
			)}

			{!isSingleConnection ? (
				<>
					<div className="linear-section-title">통합 템플릿</div>
					<p className="linear-section-desc">각 템플릿은 여러 연결을 가질 수 있습니다. 카드를 눌러 해당 유형의 연결을 추가합니다.</p>
					<IntegrationsGrid counts={countsByTemplate} active={focusedTemplate ?? addTemplate} onPick={(templateId) => { if (focusedTemplate === templateId) { setFocusedTemplate(null); setAddForm(null); } else { setFocusedTemplate(templateId); setAddForm(templateId); } }} />
					{addTemplate !== null ? <AddConnectionForm templateId={addTemplate} alias={addAlias} instanceId={addInstanceId} error={addError} busy={busy} onTemplate={(templateId) => { setFocusedTemplate(templateId); setAddTemplate(templateId); setAddAlias(defaultAlias(aliasSet, templateId)); }} onAlias={setAddAlias} onInstanceId={setAddInstanceId} onCancel={() => setAddForm(null)} onSubmit={() => void addConnection()} /> : null}
				</>
			) : null}
		</div>
	);
}

/* ------------------------------------------------------------- overview -- */

function IntegrationsGrid({
	counts,
	active,
	onPick,
}: {
	readonly counts: ReadonlyMap<string, number>;
	readonly active: string | null;
	readonly onPick: (templateId: string) => void;
}): ReactElement {
	return (
		<div
			style={{
				display: "grid",
				gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))",
				gap: "var(--space-8)",
				marginTop: "var(--space-8)",
			}}
		>
			{TEMPLATES.map((template) => {
				const count = counts.get(template.id) ?? 0;
				const selected = active === template.id;
				return (
					<button
						key={template.id}
						type="button"
						className="provider-row"
						aria-pressed={selected}
						style={{
							flexDirection: "column",
							alignItems: "stretch",
							gap: "var(--space-6)",
							textAlign: "left",
							cursor: "pointer",
							borderColor: selected ? "var(--accent)" : undefined,
						}}
						onClick={() => onPick(template.id)}
					>
						<div style={{ display: "flex", alignItems: "center", gap: "var(--space-8)" }}>
							<span className="provider-icon">{template.label[0]?.toUpperCase() ?? "?"}</span>
							<span className="provider-name" style={{ flex: 1 }}>
								{template.label}
							</span>
							<PlusIcon />
						</div>
						<span className="provider-models" style={{ whiteSpace: "normal" }}>
							{template.summary}
						</span>
						<div style={{ display: "flex", alignItems: "center", gap: "var(--space-6)" }}>
							<span className="provider-tag">{template.id}</span>
							{template.binary !== null ? <span className="provider-tag">{template.binary}</span> : null}
							<span style={HINT_TEXT}>{count}개 연결</span>
						</div>
					</button>
				);
			})}
		</div>
	);
}

function AddConnectionForm({
	templateId,
	alias,
	instanceId,
	error,
	busy,
	onTemplate,
	onAlias,
	onInstanceId,
	onCancel,
	onSubmit,
}: {
	readonly templateId: string;
	readonly alias: string;
	readonly instanceId: string;
	readonly error: string | null;
	readonly busy: boolean;
	readonly onTemplate: (templateId: string) => void;
	readonly onAlias: (alias: string) => void;
	readonly onInstanceId: (instanceId: string) => void;
	readonly onCancel: () => void;
	readonly onSubmit: () => void;
}): ReactElement {
	return (
		<form
			id="datasource-add-form"
			className="settings-source-desc"
			aria-label="새 데이터소스 연결"
			style={{ marginTop: "var(--space-8)", border: "1px solid var(--border-divider)", borderRadius: "var(--radius-10)" }}
			onSubmit={(event) => {
				event.preventDefault();
				onSubmit();
			}}
		>
			<div className="settings-source-desc__header">
				<span>새 연결</span>
			</div>
			<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "var(--space-10)" }}>
				<FieldShell label="템플릿">
					<select
						id="datasource-add-template"
						className="linear-select"
						style={CONTROL_INPUT}
						aria-label="템플릿"
						value={templateId}
						onChange={(event) => onTemplate(event.target.value)}
					>
						{TEMPLATES.map((template) => (
							<option key={template.id} value={template.id}>
								{template.label}
							</option>
						))}
					</select>
				</FieldShell>
				<FieldShell label="연결 id (alias)" hint="같은 템플릿을 여러 개 연결할 때 서로 다른 id를 쓰세요.">
					<input
						id="datasource-add-alias"
						className="settings-source-desc__input"
						aria-label="연결 id (alias)"
						value={alias}
						autoFocus
						onChange={(event) => onAlias(event.target.value)}
					/>
				</FieldShell>
				<FieldShell label="instanceId" hint="소스 경로·컬렉션 이름에 쓰입니다.">
					<input
						id="datasource-add-instance"
						className="settings-source-desc__input"
						aria-label="instanceId"
						value={instanceId}
						onChange={(event) => onInstanceId(event.target.value)}
					/>
				</FieldShell>
			</div>
			{error !== null ? (
				<p style={{ margin: 0, color: "var(--danger-text)", fontSize: "var(--font-size-meta)" }} role="alert">
					{error}
				</p>
			) : null}
			<div className="settings-source-desc__actions">
				<button type="button" disabled={busy} onClick={onCancel}>
					취소
				</button>
				<button type="submit" className="is-primary" disabled={busy}>
					{busy ? "추가 중…" : "연결 추가"}
				</button>
			</div>
		</form>
	);
}

/* -------------------------------------------------------------- one card -- */

function ConnectionCard({
	alias,
	raw,
	row,
	allowedTags,
	busy,
	expanded,
	confirmingDelete,
	onToggleExpanded,
	onToggleEnabled,
	onRequestDelete,
	onCancelDelete,
	onConfirmDelete,
	onCommit,
	onSetAccess,
	onDismissError,
}: {
	readonly alias: string;
	readonly raw: unknown;
	readonly row: DataSourceRow | undefined;
	readonly allowedTags: readonly string[];
	readonly busy: boolean;
	readonly expanded: boolean;
	readonly confirmingDelete: boolean;
	readonly onToggleExpanded: () => void;
	readonly onToggleEnabled: (enabled: boolean) => void;
	readonly onRequestDelete: () => void;
	readonly onCancelDelete: () => void;
	readonly onConfirmDelete: () => void;
	readonly onCommit: (draft: Record<string, unknown>, baseline: Record<string, unknown>, newAlias: string) => Promise<string | null>;
	readonly onSetAccess: (tags: string[]) => void;
	readonly onDismissError: () => void;
}): ReactElement {
	const original = useMemo(() => entryOf(raw), [raw]);
	const [baseline, setBaseline] = useState<Record<string, unknown>>(() => clone(original));
	const [draft, setDraft] = useState<Record<string, unknown>>(() => clone(original));
	const baselineRef = useRef(baseline);
	const [newAlias, setNewAlias] = useState(alias);
	const [saveError, setSaveError] = useState<string | null>(null);

	// Adopt external changes for fields the user has not edited. The shared
	// autosave queue serializes a write already in flight and retains the latest
	// pending draft when the user switches datasource tabs.
	useEffect(() => {
		const incoming = entryOf(raw);
		const previous = baselineRef.current;
		const nextDraft = asRecord(reconcileValue(draft, previous, incoming));
		draftRef.current = nextDraft;
		setDraft(nextDraft);
		const nextBaseline = clone(incoming);
		baselineRef.current = nextBaseline;
		setBaseline(nextBaseline);
		setSaveError(null);
	}, [raw]);

	const templateType = typeof draft.type === "string" && draft.type.length > 0 ? draft.type : alias;
	const meta = TEMPLATE_BY_ID[templateType];
	const enabled = draft.enabled !== false;
	const connector = asRecord(draft.connector);
	const channels = asRecord(draft.channels);
	const tags = asStringArray(draft.tags);
	const effectiveTags = row?.agent.tags.length ? row.agent.tags : tags;
	const dirty = JSON.stringify(baseline) !== JSON.stringify(draft) || newAlias.trim() !== alias;

	const autoSave = useAutoSave<{ readonly draft: Record<string, unknown>; readonly newAlias: string }>({
		key: (value) => JSON.stringify({ draft: value.draft, newAlias: value.newAlias.trim() }),
		perform: async (value) => {
			const error = await onCommit(value.draft, baselineRef.current, value.newAlias);
			if (error !== null) {
				setSaveError(error);
				throw new Error(error);
			}
			const nextBaseline = clone(value.draft);
			baselineRef.current = nextBaseline;
			setBaseline(nextBaseline);
			setSaveError(null);
		},
	});
	const { queue: queueSave, flush: flushSave, cancel: cancelSave, busy: saving } = autoSave;
	const draftRef = useRef(draft);
	const newAliasRef = useRef(newAlias);
	const dirtyRef = useRef(dirty);
	draftRef.current = draft;
	newAliasRef.current = newAlias;
	dirtyRef.current = dirty;

	useEffect(() => {
		if (!dirty) {
			if (!saving) cancelSave();
			return;
		}
		queueSave({ draft: clone(draft), newAlias });
	}, [cancelSave, dirty, draft, newAlias, queueSave, saving]);

	useEffect(() => () => {
		if (dirtyRef.current) flushSave({ draft: clone(draftRef.current), newAlias: newAliasRef.current });
	}, [flushSave]);

	const updateDraft = (mutate: (current: Record<string, unknown>) => Record<string, unknown>, enqueue = true): void => {
		const next = mutate(draftRef.current);
		draftRef.current = next;
		dirtyRef.current = JSON.stringify(baselineRef.current) !== JSON.stringify(next) || newAliasRef.current.trim() !== alias;
		setDraft(next);
		if (enqueue) queueSave({ draft: clone(next), newAlias: newAliasRef.current });
	};
	const updateAlias = (value: string, enqueue = true): void => {
		newAliasRef.current = value;
		dirtyRef.current = JSON.stringify(baselineRef.current) !== JSON.stringify(draftRef.current) || value.trim() !== alias;
		setNewAlias(value);
		if (enqueue) queueSave({ draft: clone(draftRef.current), newAlias: value });
	};

	const setField = (path: string[], value: unknown): void => {
		setSaveError(null);
		updateDraft((current) => withPath(current, path, value));
	};

	return (
		<div className={`settings-source${expanded ? " is-open" : ""}`} data-source-id={alias}>
			<div className="settings-source__row">
				<span className="provider-icon">{alias[0]?.toUpperCase() ?? "?"}</span>
				<div className="settings-source__body" onClick={onToggleExpanded}>
					<span className="settings-source__name">
						{alias}
						<span className="provider-tag">{templateType}</span>
						{meta === undefined ? <span className="provider-tag" style={{ color: "var(--warn-text)" }}>unsupported</span> : null}
					</span>
					<span className="settings-source__detail">
						{row === undefined
							? INSTALL_LABELS.builtin
							: `${INSTALL_LABELS[row.install.state]} · 에이전트 ${AGENT_LABELS[row.agent.state]}`}
					</span>
				</div>
				<div className="settings-source__track">
					{row !== undefined ? (
						<>
							<span className={`provider-status source-status--${row.status}`}>{STATUS_LABELS[row.status]}</span>
							<span className="settings-source__pct">{indexSummary(row.index)}</span>
						</>
					) : null}
				</div>
				<button
					type="button"
					className={`settings-source__chevron${expanded ? " is-open" : ""}`}
					title="편집"
					aria-label={`${alias} 편집`}
					onClick={onToggleExpanded}
				>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
						<path d="M6 9l6 6 6-6" />
					</svg>
				</button>
				<Switch checked={enabled} onChange={() => onToggleEnabled(!enabled)} disabled={busy} ariaLabel={`${alias} 사용`} />
			</div>

			{expanded ? (
				<div className="settings-source-desc" style={GROUP_STACK}>
					{confirmingDelete ? (
						<div className="settings-error" role="alert" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-12)" }}>
							<span>'{alias}' 연결을 설정에서 삭제할까요? 네이티브 보관 파일은 지우지 않습니다.</span>
							<span style={{ display: "flex", gap: "var(--space-6)" }}>
								<button type="button" className="linear-btn" onClick={onCancelDelete} disabled={busy}>
									취소
								</button>
								<button type="button" className="linear-btn is-danger" onClick={onConfirmDelete} disabled={busy}>
									삭제
								</button>
							</span>
						</div>
					) : null}

					{row !== undefined ? (
						<dl className="settings-source-facts">
							<StatusFact fact="install" label="설치" state={row.install.state} value={INSTALL_LABELS[row.install.state]} detail={row.install.detail} />
							<StatusFact
								fact="agent"
								label="에이전트 연동"
								state={row.agent.state}
								value={AGENT_LABELS[row.agent.state]}
								detail={[row.agent.detail, row.agent.tags.length > 0 ? `tags: ${row.agent.tags.join(", ")}` : null].filter(Boolean).join(" · ")}
							/>
							<StatusFact
								fact="index"
								label="인덱스"
								state={row.index.state}
								value={INDEX_LABELS[row.index.state]}
								detail={[row.index.detail, row.index.indexedAt === null ? "" : new Date(row.index.indexedAt).toLocaleString()].filter(Boolean).join(" · ")}
							/>
						</dl>
					) : (
						<p style={HINT_TEXT}>상태를 불러오지 못했습니다. 새로고침하면 sources:list 결과가 표시됩니다.</p>
					)}

					{meta === undefined ? (
						<>
							<p style={{ margin: 0, color: "var(--warn-text)", fontSize: "var(--font-size-meta)" }}>
								'{templateType}' 템플릿은 AutoRAG에 없습니다. 에이전트가 건너뜁니다. 아래 원본 값은 그대로 보존됩니다.
							</p>
							<ReadonlyJson value={original} />
							<div className="settings-source-desc__actions">
								<button type="button" className="linear-btn is-danger" onClick={onRequestDelete} disabled={busy}>
									<TrashIcon /> 연결 삭제
								</button>
							</div>
						</>
					) : (
						<>
							<Section title="기본">
								<FieldShell label="연결 id (alias)" hint="이름을 바꾸면 기존 설정이 새 id로 이동합니다. 중복 id는 거부됩니다.">
									<input
										className="settings-source-desc__input"
										aria-label="연결 id (alias)"
										value={newAlias}
										onChange={(event) => updateAlias(event.target.value)}
									/>
								</FieldShell>
								<FieldShell label="템플릿 (type)" hint="이 연결이 사용할 AutoRAG 데이터소스 템플릿입니다.">
									<select
										className="linear-select"
										style={CONTROL_INPUT}
										aria-label="템플릿 (type)"
										value={templateType}
										onChange={(event) => setField(["type"], event.target.value === alias ? undefined : event.target.value)}
									>
										{TEMPLATES.map((template) => (
											<option key={template.id} value={template.id}>
												{template.label} ({template.id})
											</option>
										))}
									</select>
								</FieldShell>
								<FieldShell label="instanceId" hint="소스 경로·컬렉션 이름에 쓰이는 연결 인스턴스 id입니다.">
									<input
										className="settings-source-desc__input"
										aria-label="instanceId"
										value={typeof draft.instanceId === "string" ? draft.instanceId : ""}
										onChange={(event) => setField(["instanceId"], event.target.value.length === 0 ? undefined : event.target.value)}
									/>
								</FieldShell>
								{meta.polling ? (
									<FieldShell label="폴링 간격 (ms)" hint="이 연결을 다시 폴링하는 주기입니다.">
										<input
											type="number"
											className="settings-source-desc__input"
											aria-label="폴링 간격 (ms)"
											value={typeof draft.pollingIntervalMs === "number" ? String(draft.pollingIntervalMs) : ""}
											onChange={(event) => {
												const parsed = Number(event.target.value);
												setField(["pollingIntervalMs"], event.target.value.length === 0 || !Number.isFinite(parsed) ? undefined : parsed);
											}}
										/>
									</FieldShell>
								) : null}
								<FieldShell label="태그" hint="에이전트 접근 정책은 태그로 결정됩니다. 지정하면 템플릿 기본 태그를 대체합니다.">
									<ListEditor value={tags} onChange={(next) => setField(["tags"], next)} placeholder="tag" ariaLabel="태그" />
								</FieldShell>
								<FieldShell label="설명" hint="에이전트가 이 데이터소스를 언제 쓰면 좋은지 알려 주는 문맥입니다.">
									<textarea
										className="settings-source-desc__input"
										rows={2}
										aria-label="설명"
										value={typeof draft.description === "string" ? draft.description : ""}
										onChange={(event) => setField(["description"], event.target.value.length === 0 ? undefined : event.target.value)}
									/>
								</FieldShell>
							</Section>

							{meta.channels !== "none" ? (
								<Section title="채널 필터">
									<FieldShell label="채널 id" hint="지정한 채널 id로 좁힙니다. 비우면 백엔드 기본(전체 채널) 동작입니다.">
										<ListEditor
											value={asStringArray(channels.ids)}
											onChange={(next) => setField(["channels", "ids"], next.length === 0 ? undefined : next)}
											placeholder="C01234567"
											ariaLabel="채널 id"
										/>
									</FieldShell>
									{meta.channels === "both" ? (
										<FieldShell label="채널 이름" hint="id 대신 이름으로도 제한할 수 있습니다.">
											<ListEditor
												value={asStringArray(channels.names)}
												onChange={(next) => setField(["channels", "names"], next.length === 0 ? undefined : next)}
												placeholder="general"
												ariaLabel="채널 이름"
											/>
										</FieldShell>
									) : null}
								</Section>
							) : null}

							{meta.groups.map((group) => (
								<Section key={group.title} title={group.title}>
									{group.fields.map((field) => (
										<ConnectorField
											key={field.key}
											field={field}
											value={readAt(connector, field.key.split("."))}
											onChange={(value) => setField(["connector", ...field.key.split(".")], value)}
										/>
									))}
								</Section>
							))}

							{templateType === "github" || templateType === "github-gist" ? (
								<>
									<SecretNotice stored={typeof connector.token === "string"} />
									<CredentialControl
										envName={typeof connector.tokenEnv === "string" && connector.tokenEnv.length > 0 ? connector.tokenEnv : "GITHUB_TOKEN"}
									/>
								</>
							) : null}

							<AccessControl
								effectiveTags={effectiveTags}
								allowedTags={allowedTags}
								busy={busy}
								onSetAccess={onSetAccess}
							/>

							<details>
								<summary style={{ ...HINT_TEXT, cursor: "pointer" }}>원본 connector JSON 보기</summary>
								<ReadonlyJson value={connector} />
							</details>
						</>
					)}

					{saveError !== null ? (
						<div className="settings-error" role="alert">
							{saveError}
						</div>
					) : null}

					{meta === undefined ? null : (
						<div className="settings-source-desc__actions">
							{saving ? <span style={HINT_TEXT}>변경 사항 저장 중…</span> : null}
							<button type="button" className="linear-btn is-danger" onClick={onRequestDelete} disabled={busy || saving}>
								<TrashIcon /> 연결 삭제
							</button>
							<button type="button" className="linear-btn" disabled={saving || !dirty} onClick={() => { onDismissError(); updateDraft(() => clone(baselineRef.current)); updateAlias(alias); setSaveError(null); }}>
								되돌리기
							</button>
						</div>
					)}
				</div>
			) : null}
		</div>
	);
}

/* ------------------------------------------------------------- controls -- */

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }): ReactElement {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: "var(--space-8)", borderTop: "1px solid var(--border-divider)", paddingTop: "var(--space-10)" }}>
			<span style={{ fontSize: "var(--font-size-meta)", fontWeight: "var(--weight-semibold)", color: "var(--text-primary)" }}>{title}</span>
			{children}
		</div>
	);
}

function FieldShell({ label, hint, children }: { readonly label: string; readonly hint?: string; readonly children: ReactElement }): ReactElement {
	return (
		<div style={ROW_STACK}>
			<span style={{ fontSize: "var(--font-size-meta)", color: "var(--text-muted)", fontWeight: "var(--weight-medium)" }}>{label}</span>
			{children}
			{hint !== undefined && hint.length > 0 ? <span style={HINT_TEXT}>{hint}</span> : null}
		</div>
	);
}

function ConnectorField({ field, value, onChange }: { readonly field: FieldSpec; readonly value: unknown; readonly onChange: (value: unknown) => void }): ReactElement {
	if (field.kind === "boolean") {
		const checked = typeof value === "boolean" ? value : field.defaultValue === true;
		return (
			<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-12)" }}>
				<span style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: "var(--font-size-meta)", color: "var(--text-muted)" }}>
					{field.label}
					{field.hint !== undefined && field.hint.length > 0 ? <span style={HINT_TEXT}>{field.hint}</span> : null}
				</span>
				<Switch checked={checked} onChange={() => onChange(!checked)} ariaLabel={field.label} />
			</div>
		);
	}
	return (
		<FieldShell label={field.label} {...(field.hint === undefined ? {} : { hint: field.hint })}>
			<ConnectorFieldInput field={field} value={value} onChange={onChange} />
		</FieldShell>
	);
}

function ConnectorFieldInput({ field, value, onChange }: { readonly field: FieldSpec; readonly value: unknown; readonly onChange: (value: unknown) => void }): ReactElement {
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

function ReadonlyJson({ value }: { readonly value: unknown }): ReactElement {
	return (
		<pre
			style={{
				margin: "var(--space-6) 0 0",
				padding: "var(--space-10) var(--space-12)",
				border: "1px solid var(--border-divider)",
				borderRadius: "var(--radius-8)",
				background: "var(--bg-subtle)",
				fontSize: "var(--font-size-badge)",
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
				color: "var(--text-body)",
				overflowX: "auto",
				whiteSpace: "pre-wrap",
				wordBreak: "break-word",
			}}
		>
			{JSON.stringify(value, null, 2)}
		</pre>
	);
}

function CredentialControl({ envName }: { readonly envName: string }): ReactElement {
	const [status, setStatus] = useState<ProviderCredentialStatus | null>(null);
	const [secret, setSecret] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let active = true;
		settings
			.credentialsList([envName])
			.then((list) => {
				if (active) setStatus(list.find((entry) => entry.envName === envName) ?? null);
			})
			.catch((cause: unknown) => {
				if (active) setError(errorText(cause));
			});
		return () => {
			active = false;
		};
	}, [envName]);

	async function save(): Promise<void> {
		if (secret.length === 0 || busy) return;
		setBusy(true);
		setError(null);
		try {
			const list = await settings.credentialsSet(envName, secret);
			setStatus(list.find((entry) => entry.envName === envName) ?? null);
			setSecret("");
		} catch (cause) {
			setError(errorText(cause));
		} finally {
			setBusy(false);
		}
	}

	async function remove(): Promise<void> {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const list = await settings.credentialsRemove(envName);
			setStatus(list.find((entry) => entry.envName === envName) ?? null);
		} catch (cause) {
			setError(errorText(cause));
		} finally {
			setBusy(false);
		}
	}

	const sourceLabel = status === null ? "확인 안 됨" : status.stored ? "앱 보관(암호화)" : status.source === "env" ? "환경변수" : "없음";

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)", borderTop: "1px solid var(--border-divider)", paddingTop: "var(--space-10)" }}>
			<span style={{ fontSize: "var(--font-size-meta)", fontWeight: "var(--weight-semibold)", color: "var(--text-primary)" }}>자격 증명 · {envName}</span>
			<span style={HINT_TEXT}>
				토큰은 config.json에 저장하지 않고, 앱의 암호화 저장소에 {envName} 이름으로 보관되어 에이전트 환경변수로 주입됩니다. 현재 소스: {sourceLabel}
			</span>
			<div style={{ display: "flex", gap: "var(--space-6)" }}>
				<input
					type="password"
					className="settings-source-desc__input"
					aria-label={`${envName} 토큰`}
					placeholder={`${envName} 토큰`}
					value={secret}
					autoComplete="off"
					onChange={(event) => setSecret(event.target.value)}
				/>
				<button type="button" className="linear-btn is-primary" disabled={busy || secret.length === 0} onClick={() => void save()}>
					{busy ? "저장 중…" : "보관"}
				</button>
				{status?.stored === true ? (
					<button type="button" className="linear-btn is-danger" disabled={busy} onClick={() => void remove()}>
						삭제
					</button>
				) : null}
			</div>
			{error !== null ? (
				<span style={{ ...HINT_TEXT, color: "var(--danger-text)" }} role="alert">
					{error}
				</span>
			) : null}
		</div>
	);
}

function SecretNotice({ stored }: { readonly stored: boolean }): ReactElement {
	return (
		<div
			style={{
				fontSize: "var(--font-size-meta)",
				padding: "10px var(--space-12)",
				borderRadius: "var(--radius-8)",
				border: `1px solid ${stored ? "var(--danger-border)" : "var(--border-divider)"}`,
				background: stored ? "var(--danger-bg-soft)" : "var(--bg-subtle)",
				color: stored ? "var(--danger-text)" : "var(--text-muted)",
			}}
		>
			{stored
				? "이 연결은 config에 평문 토큰을 저장하고 있습니다. 토큰 자체는 여기서 편집하지 않습니다. tokenEnv로 옮기거나 gh CLI 인증을 쓰세요."
				: "토큰은 config에 저장하지 않습니다. tokenEnv(환경 변수 이름) 또는 gh CLI 인증을 사용합니다."}
		</div>
	);
}

function AccessControl({
	effectiveTags,
	allowedTags,
	busy,
	onSetAccess,
}: {
	readonly effectiveTags: readonly string[];
	readonly allowedTags: readonly string[];
	readonly busy: boolean;
	readonly onSetAccess: (tags: string[]) => void;
}): ReactElement {
	const allowed = new Set(allowedTags);
	const granted = effectiveTags.length > 0 && effectiveTags.every((tag) => allowed.has(tag));
	const denyAll = allowedTags.length === 0;

	function grant(): void {
		onSetAccess([...allowedTags, ...effectiveTags.filter((tag) => !allowed.has(tag))]);
	}

	function revoke(): void {
		const own = new Set(effectiveTags);
		onSetAccess(allowedTags.filter((tag) => !own.has(tag)));
	}

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)", borderTop: "1px solid var(--border-divider)", paddingTop: "var(--space-10)" }}>
			<span style={{ fontSize: "var(--font-size-meta)", fontWeight: "var(--weight-semibold)", color: "var(--text-primary)" }}>에이전트 접근</span>
			{denyAll ? (
				<span style={{ ...HINT_TEXT, color: "var(--warn-text)" }}>
					기본 거부 상태입니다. datasourceAccess.allowedTags가 비어 있어 어떤 데이터소스도 허용되지 않습니다.
				</span>
			) : null}
			{effectiveTags.length === 0 ? (
				<span style={HINT_TEXT}>이 연결의 태그를 알 수 없어 접근을 부여할 수 없습니다. 위에서 태그를 지정하거나 저장하세요.</span>
			) : (
				<>
					<span style={HINT_TEXT}>
						이 연결의 태그: {effectiveTags.join(", ")} · 현재 허용된 태그: {allowedTags.length > 0 ? allowedTags.join(", ") : "(없음)"}
					</span>
					<div style={{ display: "flex", gap: "var(--space-6)" }}>
						{granted ? (
							<button type="button" className="linear-btn" disabled={busy} onClick={revoke}>
								접근 회수
							</button>
						) : (
							<button type="button" className="linear-btn is-primary" disabled={busy} onClick={grant}>
								에이전트 접근 허용
							</button>
						)}
					</div>
					<span style={HINT_TEXT}>태그는 다른 연결과 공유될 수 있습니다. 허용하면 같은 태그를 쓰는 연결에도 열릴 수 있습니다.</span>
				</>
			)}
		</div>
	);
}

function StatusFact({
	fact,
	label,
	state,
	value,
	detail,
}: {
	readonly fact: string;
	readonly label: string;
	readonly state: string;
	readonly value: string;
	readonly detail: string;
}): ReactElement {
	return (
		<div className="settings-source-fact" data-fact={fact} data-state={state}>
			<dt>{label}</dt>
			<dd>
				<strong>{value}</strong>
				<span>{detail}</span>
			</dd>
		</div>
	);
}
