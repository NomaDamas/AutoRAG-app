/**
 * Settings > Deep Indexing / Light Indexing / Other Apps — typed config forms.
 *
 * Replaces the raw JSON block editors with real controls over the serializable
 * AutoRAG config surface. Every write is a leaf-level `configPatch`, so sibling
 * and unknown leaves on disk are never clobbered; removals revert a leaf to the
 * upstream default. Block sections that upstream stores as `false` (fsearch,
 * everything, dupey, jikji, minSync) keep their `false`-vs-enabled cutover.
 *
 * Field provenance (read-only reference, never modified):
 *   .upstream/autorag/src/cli/config.ts (CliConfig, allowlists, normalization)
 *   .upstream/autorag/src/parser/{defaults,ocr,kordoc}.ts
 *   .upstream/autorag/src/minsync/{installer,types,embedder-config}.ts
 *   .upstream/autorag/src/jikji/types.ts
 *   .upstream/autorag/src/p2p/policy.ts
 */

import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from "react";
import type {
	AutoRagConfigSnapshot,
	AutoRagConfigUpdate,
	JsonObject,
	JsonValue,
} from "../../../../shared/settings-contract";
import { isJsonObject } from "../../../../shared/settings-contract";
import { Switch } from "../primitives/Switch";
import { LanguageSettings } from "./LanguageSettings";

import { settings } from "../../settings-runtime";

type ConfigPath = readonly string[];


/* ------------------------------------------------------------- utilities -- */

function readAt(root: JsonObject, path: ConfigPath): JsonValue | undefined {
	let current: JsonValue = root;
	for (const part of path) {
		if (!isJsonObject(current)) return undefined;
		current = current[part] as JsonValue;
	}
	return current;
}

function listOf(value: JsonValue | undefined): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** A disabled block is upstream's `false` marker or an object with `enabled: false`. */
function blockDisabled(value: JsonValue | undefined): boolean {
	return value === false || (isJsonObject(value) && value.enabled === false);
}

/* ----------------------------------------------------------- presentation -- */

function heading(title: string, description: string): ReactElement {
	return (
		<div className="linear-header">
			<h2 className="linear-title">{title}</h2>
			<p className="linear-desc">{description}</p>
		</div>
	);
}

function Row({ name, hint, children }: { readonly name: string; readonly hint: string; readonly children: ReactNode }): ReactElement {
	return (
		<div className="linear-row">
			<div className="linear-row-label">
				<span className="linear-row-name">{name}</span>
				<small>{hint}</small>
			</div>
			<div className="linear-control">{children}</div>
		</div>
	);
}

function Section({ title, description, children }: { readonly title: string; readonly description?: string; readonly children: ReactNode }): ReactElement {
	return (
		<>
			<div className="linear-section-title">{title}</div>
			{description ? <p className="linear-section-desc">{description}</p> : null}
			{children}
		</>
	);
}

function ResetButton({ label, onClick, disabled }: { readonly label: string; readonly onClick: () => void; readonly disabled: boolean }): ReactElement {
	return (
		<button type="button" className="linear-btn settings-config__reset" disabled={disabled} title={`${label} 기본값으로`} onClick={onClick}>
			기본값
		</button>
	);
}

/* ---------------------------------------------------------------- writes -- */

function useFieldCommit(onSaved: (next: AutoRagConfigSnapshot) => void): {
	readonly saving: boolean;
	readonly error: string | null;
	readonly setError: (message: string | null) => void;
	readonly commit: (ops: readonly AutoRagConfigUpdate[]) => Promise<void>;
} {
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const commit = useCallback(
		async (ops: readonly AutoRagConfigUpdate[]): Promise<void> => {
			if (ops.length === 0) return;
			setSaving(true);
			setError(null);
			try {
				const next = await settings.configPatch(ops);
				onSaved(next);
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				setSaving(false);
			}
		},
		[onSaved],
	);
	return { saving, error, setError, commit };
}

/* ------------------------------------------------------------- field rows -- */

function TextFieldRow({
	snapshot,
	path,
	name,
	hint,
	placeholder,
	onSaved,
	disabled = false,
}: {
	readonly snapshot: AutoRagConfigSnapshot;
	readonly path: ConfigPath;
	readonly name: string;
	readonly hint: string;
	readonly placeholder?: string;
	readonly onSaved: (next: AutoRagConfigSnapshot) => void;
	readonly disabled?: boolean;
}): ReactElement {
	const stored = readAt(snapshot.config, path);
	const current = typeof stored === "string" ? stored : "";
	const [draft, setDraft] = useState(current);
	const signature = typeof stored === "string" ? stored : null;
	useEffect(() => setDraft(current), [signature]);
	const { saving, error, commit } = useFieldCommit(onSaved);
	function save(): void {
		void commit([draft.length === 0 ? { path: [...path], remove: true } : { path: [...path], value: draft }]);
	}
	return (
		<Row name={name} hint={hint}>
			<div className="settings-field-stack">
				<input
					className="settings-source-desc__input"
					aria-label={name}
					value={draft}
					placeholder={placeholder}
					disabled={disabled || saving}
					onChange={(event) => setDraft(event.target.value)}
				/>
				<div className="settings-field-actions">
					<button type="button" className="linear-btn" disabled={disabled || saving} onClick={save}>
						{saving ? "저장 중…" : "저장"}
					</button>
					{stored !== undefined ? <ResetButton label={name} disabled={disabled || saving} onClick={() => void commit([{ path: [...path], remove: true }])} /> : null}
					{error ? <span className="settings-inline-error">{error}</span> : null}
				</div>
			</div>
		</Row>
	);
}

function NumberFieldRow({
	snapshot,
	path,
	name,
	hint,
	placeholder,
	min,
	max,
	onSaved,
	disabled = false,
}: {
	readonly snapshot: AutoRagConfigSnapshot;
	readonly path: ConfigPath;
	readonly name: string;
	readonly hint: string;
	readonly placeholder?: string;
	readonly min?: number;
	readonly max?: number;
	readonly onSaved: (next: AutoRagConfigSnapshot) => void;
	readonly disabled?: boolean;
}): ReactElement {
	const stored = readAt(snapshot.config, path);
	const current = typeof stored === "number" && Number.isFinite(stored) ? stored : null;
	const [draft, setDraft] = useState(current === null ? "" : String(current));
	const signature = current === null ? null : String(current);
	useEffect(() => setDraft(current === null ? "" : String(current)), [signature]);
	const { saving, error, setError, commit } = useFieldCommit(onSaved);
	function save(): void {
		const trimmed = draft.trim();
		if (trimmed.length === 0) {
			void commit([{ path: [...path], remove: true }]);
			return;
		}
		const parsed = Number(trimmed);
		if (!Number.isFinite(parsed)) {
			setError("숫자를 입력하세요.");
			return;
		}
		if (min !== undefined && parsed < min) {
			setError(`최소값은 ${min}입니다.`);
			return;
		}
		if (max !== undefined && parsed > max) {
			setError(`최대값은 ${max}입니다.`);
			return;
		}
		void commit([{ path: [...path], value: parsed }]);
	}
	return (
		<Row name={name} hint={hint}>
			<div className="settings-field-stack">
				<input
					className="settings-source-desc__input"
					style={{ width: 180 }}
					type="number"
					aria-label={name}
					value={draft}
					placeholder={placeholder}
					disabled={disabled || saving}
					onChange={(event) => setDraft(event.target.value)}
				/>
				<div className="settings-field-actions">
					<button type="button" className="linear-btn" disabled={disabled || saving} onClick={save}>
						{saving ? "저장 중…" : "저장"}
					</button>
					{stored !== undefined ? <ResetButton label={name} disabled={disabled || saving} onClick={() => void commit([{ path: [...path], remove: true }])} /> : null}
					{error ? <span className="settings-inline-error">{error}</span> : null}
				</div>
			</div>
		</Row>
	);
}

function BoolFieldRow({
	snapshot,
	path,
	name,
	hint,
	fallback = false,
	onSaved,
	disabled = false,
}: {
	readonly snapshot: AutoRagConfigSnapshot;
	readonly path: ConfigPath;
	readonly name: string;
	readonly hint: string;
	readonly fallback?: boolean;
	readonly onSaved: (next: AutoRagConfigSnapshot) => void;
	readonly disabled?: boolean;
}): ReactElement {
	const stored = readAt(snapshot.config, path);
	const current = typeof stored === "boolean" ? stored : fallback;
	const { saving, error, commit } = useFieldCommit(onSaved);
	return (
		<Row name={name} hint={hint}>
			<div className="settings-field-inline">
				<Switch checked={current} disabled={disabled || saving} onChange={() => void commit([{ path: [...path], value: !current }])} ariaLabel={name} />
				{stored !== undefined ? <ResetButton label={name} disabled={disabled || saving} onClick={() => void commit([{ path: [...path], remove: true }])} /> : null}
				{error ? <span className="settings-inline-error">{error}</span> : null}
			</div>
		</Row>
	);
}

interface SelectOption {
	readonly key: string;
	readonly label: string;
	readonly value: JsonValue | null;
}

const INHERIT_OPTION: SelectOption = { key: "__inherit__", label: "기본값 사용", value: null };

function SelectFieldRow({
	snapshot,
	path,
	name,
	hint,
	options,
	onSaved,
	disabled = false,
}: {
	readonly snapshot: AutoRagConfigSnapshot;
	readonly path: ConfigPath;
	readonly name: string;
	readonly hint: string;
	readonly options: readonly SelectOption[];
	readonly onSaved: (next: AutoRagConfigSnapshot) => void;
	readonly disabled?: boolean;
}): ReactElement {
	const stored = readAt(snapshot.config, path);
	const match = options.find((option) => JSON.stringify(stored) === JSON.stringify(option.value));
	const isCustom = stored !== undefined && match === undefined;
	const allOptions: readonly SelectOption[] = isCustom
		? [...options, { key: "__custom__", label: `현재값: ${JSON.stringify(stored)}`, value: stored ?? null }]
		: options;
	const currentKey = isCustom ? "__custom__" : (match?.key ?? options[0]?.key ?? "");
	const [draft, setDraft] = useState(currentKey);
	useEffect(() => setDraft(currentKey), [currentKey]);
	const { saving, error, commit } = useFieldCommit(onSaved);
	function change(key: string): void {
		setDraft(key);
		const option = allOptions.find((item) => item.key === key);
		if (option === undefined || option.key === "__custom__") return;
		void commit([option.value === null ? { path: [...path], remove: true } : { path: [...path], value: option.value as JsonValue }]);
	}
	return (
		<Row name={name} hint={hint}>
			<div className="settings-field-inline">
				<select className="linear-select" aria-label={name} value={draft} disabled={disabled || saving} onChange={(event) => change(event.target.value)}>
					{allOptions.map((option) => (
						<option key={option.key} value={option.key}>
							{option.label}
						</option>
					))}
				</select>
				{error ? <span className="settings-inline-error">{error}</span> : null}
			</div>
		</Row>
	);
}

function ListFieldRow({
	snapshot,
	path,
	name,
	hint,
	placeholder,
	rows = 3,
	onSaved,
	disabled = false,
}: {
	readonly snapshot: AutoRagConfigSnapshot;
	readonly path: ConfigPath;
	readonly name: string;
	readonly hint: string;
	readonly placeholder?: string;
	readonly rows?: number;
	readonly onSaved: (next: AutoRagConfigSnapshot) => void;
	readonly disabled?: boolean;
}): ReactElement {
	const stored = readAt(snapshot.config, path);
	const current = listOf(stored);
	const [draft, setDraft] = useState(current.join("\n"));
	const signature = JSON.stringify(current);
	useEffect(() => setDraft(current.join("\n")), [signature]);
	const { saving, error, commit } = useFieldCommit(onSaved);
	function save(): void {
		const values = draft
			.split(/\r?\n/u)
			.map((item) => item.trim())
			.filter(Boolean);
		void commit([values.length === 0 ? { path: [...path], remove: true } : { path: [...path], value: values }]);
	}
	return (
		<Row name={name} hint={hint}>
			<div className="settings-field-stack">
				<textarea
					className="linear-textarea"
					aria-label={name}
					rows={rows}
					value={draft}
					placeholder={placeholder}
					disabled={disabled || saving}
					onChange={(event) => setDraft(event.target.value)}
				/>
				<div className="settings-field-actions">
					<button type="button" className="linear-btn" disabled={disabled || saving} onClick={save}>
						{saving ? "저장 중…" : "저장"}
					</button>
					{stored !== undefined ? <ResetButton label={name} disabled={disabled || saving} onClick={() => void commit([{ path: [...path], remove: true }])} /> : null}
					{error ? <span className="settings-inline-error">{error}</span> : null}
				</div>
			</div>
		</Row>
	);
}

/* -------------------------------------------------------- block sections -- */

function BlockSwitchRow({
	snapshot,
	path,
	name,
	hint,
	mode,
	defaultEnabled,
	enableValue,
	onSaved,
}: {
	readonly snapshot: AutoRagConfigSnapshot;
	readonly path: ConfigPath;
	readonly name: string;
	readonly hint: string;
	/** `false`: disable writes the `false` marker; `enabled`: disable writes `enabled: false`. */
	readonly mode: "false" | "enabled";
	readonly defaultEnabled: boolean;
	/** Value written when re-enabling from the `false` marker (default `{ enabled: true }`). */
	readonly enableValue?: JsonValue;
	readonly onSaved: (next: AutoRagConfigSnapshot) => void;
}): ReactElement {
	const stored = readAt(snapshot.config, path);
	const object = isJsonObject(stored) ? stored : {};
	const enabled = stored === undefined ? defaultEnabled : !blockDisabled(stored);
	const { saving, error, commit } = useFieldCommit(onSaved);
	function toggle(): void {
		if (enabled) {
			if (mode === "false") void commit([{ path: [...path], value: false }]);
			else void commit([{ path: [...path], value: { ...object, enabled: false } }]);
			return;
		}
		// Re-enable: merge over an existing object so sibling leaves survive; a `false`
		// marker (or absent block) is replaced by the fresh enable value.
		void commit([{ path: [...path], value: isJsonObject(stored) ? { ...stored, enabled: true } : (enableValue ?? { enabled: true }) }]);
	}
	return (
		<Row name={name} hint={hint}>
			<div className="settings-field-inline">
				<Switch checked={enabled} disabled={saving} onChange={toggle} ariaLabel={name} />
				{error ? <span className="settings-inline-error">{error}</span> : null}
			</div>
		</Row>
	);
}

/* ------------------------------------------------------------- map rows -- */



/* ------------------------------------------------------------ descriptors -- */

interface FieldSpec {
	readonly kind: "text" | "number" | "bool" | "select" | "list";
	readonly path: ConfigPath;
	readonly name: string;
	readonly hint: string;
	readonly fallback?: boolean;
	readonly placeholder?: string;
	readonly min?: number;
	readonly max?: number;
	readonly rows?: number;
	readonly options?: readonly SelectOption[];
}

function FieldRow({ spec, snapshot, onSaved }: { readonly spec: FieldSpec; readonly snapshot: AutoRagConfigSnapshot; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	if (spec.kind === "text") {
		return <TextFieldRow snapshot={snapshot} path={spec.path} name={spec.name} hint={spec.hint} onSaved={onSaved} {...(spec.placeholder === undefined ? {} : { placeholder: spec.placeholder })} />;
	}
	if (spec.kind === "number") {
		return <NumberFieldRow snapshot={snapshot} path={spec.path} name={spec.name} hint={spec.hint} onSaved={onSaved} {...(spec.placeholder === undefined ? {} : { placeholder: spec.placeholder })} {...(spec.min === undefined ? {} : { min: spec.min })} {...(spec.max === undefined ? {} : { max: spec.max })} />;
	}
	if (spec.kind === "bool") {
		return <BoolFieldRow snapshot={snapshot} path={spec.path} name={spec.name} hint={spec.hint} onSaved={onSaved} {...(spec.fallback === undefined ? {} : { fallback: spec.fallback })} />;
	}
	if (spec.kind === "select") {
		return <SelectFieldRow snapshot={snapshot} path={spec.path} name={spec.name} hint={spec.hint} options={spec.options ?? [INHERIT_OPTION]} onSaved={onSaved} />;
	}
	return <ListFieldRow snapshot={snapshot} path={spec.path} name={spec.name} hint={spec.hint} onSaved={onSaved} {...(spec.placeholder === undefined ? {} : { placeholder: spec.placeholder })} {...(spec.rows === undefined ? {} : { rows: spec.rows })} />;
}

function renderFields(specs: readonly FieldSpec[], snapshot: AutoRagConfigSnapshot, onSaved: (next: AutoRagConfigSnapshot) => void): ReactElement {
	return (
		<>
			{specs.map((spec) => (
				<FieldRow key={spec.path.join(".")} spec={spec} snapshot={snapshot} onSaved={onSaved} />
			))}
		</>
	);
}

/* ----------------------------------------------------------- field specs -- */

const MINSYNC_FIELDS: readonly FieldSpec[] = [
	{ kind: "number", path: ["minSync", "maxChunkSize"], name: "Max chunk size", hint: "청크 최대 크기(문자 수)입니다.", min: 1 },
];

const JIKJI_FIELDS: readonly FieldSpec[] = [
	{ kind: "number", path: ["jikji", "timeoutMs"], name: "Timeout (ms)", hint: "jikji 실행 제한 시간입니다.", min: 0 },
	{ kind: "number", path: ["jikji", "maxBufferBytes"], name: "Max buffer bytes", hint: "stdout 버퍼 최대 크기입니다.", min: 0 },
	{ kind: "bool", path: ["jikji", "includeHidden"], name: "Include hidden", hint: "숨김 파일을 인덱싱합니다.", fallback: false },
	{ kind: "bool", path: ["jikji", "includeSensitive"], name: "Include sensitive", hint: "민감 파일을 인덱싱합니다.", fallback: false },
	{ kind: "number", path: ["jikji", "parseTimeout"], name: "Parse timeout (ms)", hint: "문서 파싱 제한 시간입니다.", min: 0 },
	{ kind: "number", path: ["jikji", "maxFiles"], name: "Max files", hint: "인덱싱할 최대 파일 수(0 = 무제한)입니다.", min: 0 },
	{ kind: "list", path: ["jikji", "exclude"], name: "Exclude", hint: "인덱싱에서 제외할 경로/글로브를 한 줄에 하나씩 입력합니다.", placeholder: "vendor/**\n*.tmp" },
	{ kind: "number", path: ["jikji", "maxHashBytes"], name: "Max hash bytes", hint: "해시 계산 최대 바이트입니다.", min: 0 },
	{ kind: "number", path: ["jikji", "docTextMaxChars"], name: "Doc text max chars", hint: "문서 텍스트 최대 길이입니다.", min: 0 },
	{ kind: "number", path: ["jikji", "docTextChunkChars"], name: "Doc text chunk chars", hint: "문서 텍스트 청크 크기입니다.", min: 0 },
	{ kind: "bool", path: ["jikji", "writeAgentRules"], name: "Write agent rules", hint: "AGENTS.md/CLAUDE.md 라우팅 블록 주입을 허용합니다(기본: 꺼짐).", fallback: false },
	{ kind: "bool", path: ["jikji", "enableMediaIndex"], name: "Enable media index", hint: "미디어 인덱싱을 사용합니다.", fallback: false },
	{ kind: "number", path: ["jikji", "mediaIndexMaxMb"], name: "Media index max MB", hint: "미디어 인덱싱 최대 크기(MB)입니다.", min: 0 },
];



const FSEARCH_FIELDS: readonly FieldSpec[] = [
	{ kind: "text", path: ["fsearch", "binaryPath"], name: "Binary path", hint: "fsearch-cli 바이너리 경로입니다.", placeholder: "/usr/local/bin/fsearch-cli" },
	{ kind: "number", path: ["fsearch", "timeoutMs"], name: "Timeout (ms)", hint: "검색 제한 시간입니다.", min: 1 },
	{ kind: "number", path: ["fsearch", "startupTimeoutMs"], name: "Startup timeout (ms)", hint: "인덱스 시작 제한 시간입니다.", min: 1 },
	{ kind: "number", path: ["fsearch", "indexTimeoutMs"], name: "Index timeout (ms)", hint: "인덱싱 제한 시간입니다.", min: 1 },
	{ kind: "bool", path: ["fsearch", "watch"], name: "Watch", hint: "파일 변경을 감시합니다.", fallback: true },
];

const EVERYTHING_FIELDS: readonly FieldSpec[] = [
	{ kind: "number", path: ["everything", "timeoutMs"], name: "Timeout (ms)", hint: "검색 제한 시간입니다.", min: 1 },
	{ kind: "number", path: ["everything", "startupTimeoutMs"], name: "Startup timeout (ms)", hint: "Everything 시작 제한 시간입니다.", min: 1 },
	{ kind: "number", path: ["everything", "indexTimeoutMs"], name: "Index timeout (ms)", hint: "인덱싱 제한 시간입니다.", min: 1 },
];

const WEBSEARCH_PROVIDERS: readonly { readonly id: string; readonly label: string }[] = [
	{ id: "gemini", label: "Gemini" },
	{ id: "anthropic", label: "Anthropic" },
	{ id: "codex", label: "OpenAI" },
	{ id: "xai", label: "xAI" },
	{ id: "perplexity", label: "Perplexity" },
	{ id: "parallel", label: "Parallel" },
	{ id: "searxng", label: "SearXNG" },
	{ id: "startpage", label: "Startpage" },
	{ id: "duckduckgo", label: "DuckDuckGo" },
	{ id: "ecosia", label: "Ecosia" },
	{ id: "google", label: "Google" },
	{ id: "mojeek", label: "Mojeek" },
	{ id: "public", label: "Public Web" },
];

const WEBSEARCH_FIELDS: readonly FieldSpec[] = [
	{
		kind: "select",
		path: ["webSearch", "provider"],
		name: "Provider",
		hint: "기본 검색 공급자입니다.",
		options: [INHERIT_OPTION, ...WEBSEARCH_PROVIDERS.map((provider) => ({ key: provider.id, label: provider.label, value: provider.id }))],
	},
	{ kind: "list", path: ["webSearch", "order"], name: "Provider order", hint: "자동 선택 시 시도할 공급자 순서입니다. 한 줄에 하나씩 입력합니다.", placeholder: "perplexity\nparallel\nduckduckgo", rows: 4 },
	{ kind: "list", path: ["webSearch", "exclude"], name: "Excluded providers", hint: "사용하지 않을 공급자 id를 한 줄에 하나씩 입력합니다.", placeholder: "google\nmojeek" },
	{ kind: "number", path: ["webSearch", "timeoutSeconds"], name: "Timeout (seconds)", hint: "공급자 전송 제한 시간(1-300초)입니다.", min: 1, max: 300 },
];

const WEBFETCH_FIELDS: readonly FieldSpec[] = [
	{ kind: "number", path: ["webSearch", "fetch", "timeoutSeconds"], name: "Fetch timeout (seconds)", hint: "페이지 가져오기 제한 시간(1-300초)입니다.", min: 1, max: 300 },
];

const DUPEY_FIELDS: readonly FieldSpec[] = [
	{ kind: "text", path: ["dupey", "binaryPath"], name: "Binary path", hint: "dupey 실행 파일 경로입니다." },
	{ kind: "number", path: ["dupey", "timeoutMs"], name: "Timeout (ms)", hint: "스캔 제한 시간입니다.", min: 1 },
];

const PARSER_FIELDS: readonly FieldSpec[] = [
	{ kind: "bool", path: ["parserOptions", "ocr", "enabled"], name: "Enable OCR", hint: "이미지 OCR 파서를 사용합니다.", fallback: false },
	{ kind: "number", path: ["parserOptions", "ocr", "timeoutMs"], name: "OCR timeout (ms)", hint: "OCR 인식 제한 시간입니다.", min: 1 },
	{ kind: "number", path: ["parserOptions", "ocr", "maxBytes"], name: "OCR max bytes", hint: "OCR 대상 이미지 최대 크기입니다.", min: 0 },
	{
		kind: "select",
		path: ["parserOptions", "kordoc", "ocr"],
		name: "Kordoc OCR mode",
		hint: "kordoc에 전달할 OCR 모드입니다. 기본값은 AutoRAG OCR 엔진 주입입니다.",
		options: [
			{ key: "__inherit__", label: "AutoRAG OCR 엔진 사용 (기본)", value: null },
			{ key: "builtin", label: "kordoc 내장 엔진", value: true },
			{ key: "force", label: "강제 OCR", value: "force" },
			{ key: "off", label: "사용 안 함", value: false },
		],
	},
];


/* -------------------------------------------------------------- sections -- */



export function DeepSettings({ snapshot, onSaved }: { readonly snapshot: AutoRagConfigSnapshot; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	const config = snapshot.config;
	const minSync = readAt(config, ["minSync"]);
	const jikji = readAt(config, ["jikji"]);
	return (
		<>
			{heading("Deep Indexing", "파일 내용과 발견 인덱스를 위한 MinSync·Jikji 설정입니다.")}
			<Section title="Search paths" description="검색·인덱싱 루트만 관리합니다.">
				<ListFieldRow snapshot={snapshot} path={["searchPaths"]} name="Search paths" hint="한 줄에 하나의 폴더를 지정합니다." placeholder="/Users/me/Documents" onSaved={onSaved} />
			</Section>
			<Section title="MinSync" description="설치 환경과 워크스페이스는 현재 시스템에서 자동 탐지합니다.">
				<BlockSwitchRow snapshot={snapshot} path={["minSync"]} name="Enable MinSync" hint="증분·벡터 인덱싱을 사용합니다." mode="enabled" defaultEnabled onSaved={onSaved} />
				{blockDisabled(minSync) ? null : renderFields(MINSYNC_FIELDS, snapshot, onSaved)}
				<p className="settings-config__note">임베딩 모델은 Embedding Models 카테고리에서 관리합니다. 바이너리 설치, workspace, installer env/platform/arch는 자동 처리됩니다.</p>
			</Section>
			<Section title="Jikji" description="Jikji 인덱스 옵션입니다. 바이너리 경로·설치와 프로세스 환경은 자동 처리됩니다.">
				<BlockSwitchRow snapshot={snapshot} path={["jikji"]} name="Enable Jikji" hint="Jikji 인덱스/검색을 사용합니다." mode="false" defaultEnabled enableValue={{}} onSaved={onSaved} />
				{blockDisabled(jikji) ? null : renderFields(JIKJI_FIELDS, snapshot, onSaved)}
			</Section>
		</>
	);
}

export function LightSettings({ snapshot, onSaved }: { readonly snapshot: AutoRagConfigSnapshot; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	const config = snapshot.config;
	const platform = typeof navigator !== "undefined" && /Mac|Linux/u.test(navigator.platform) ? "fsearch" : "everything";
	const backend = readAt(config, [platform]);
	return (
		<>
			{heading("Light Indexing", "파일명 탐색과 인덱스 제외 정책입니다.")}
			<Section title={platform === "fsearch" ? "FSearch (macOS/Linux)" : "Everything (Windows)"} description="현재 운영체제에 맞는 파일 검색 백엔드를 자동 선택합니다.">
				{blockDisabled(backend) ? <p className="linear-section-desc">현재 플랫폼 파일 검색이 비활성화되어 있습니다.</p> : renderFields(platform === "fsearch" ? FSEARCH_FIELDS : EVERYTHING_FIELDS, snapshot, onSaved)}
				<p className="linear-section-desc">Detected backend: {platform}</p>
			</Section>
			<Section title="Excluded folders" description="제외 설정은 실제 excludePaths에 저장됩니다.">
				<ListFieldRow snapshot={snapshot} path={["excludePaths"]} name="Excluded folders and files" hint="한 줄에 하나씩 입력합니다." placeholder="node_modules\n.git\ndist" onSaved={onSaved} />
			</Section>
			<Section title="Automatic code-folder exclusions" description="검색 루트 안의 코드·의존성 폴더를 자동으로 제외합니다.">
				<BoolFieldRow snapshot={snapshot} path={["appIndexing", "excludeCodeFolders"]} name="Exclude code and dependency folders" hint="기본값: 켜짐" fallback onSaved={onSaved} />
				<ListFieldRow snapshot={snapshot} path={["appIndexing", "codeFolderNames"]} name="Folder names" hint="한 줄에 하나씩. 예: .git, node_modules, dist" placeholder="node_modules\n.git" onSaved={onSaved} />
			</Section>
		</>
	);
}
export function AppsSettings({ snapshot, onSaved }: { readonly snapshot: AutoRagConfigSnapshot; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	const config = snapshot.config;
	const webSearch = readAt(config, ["webSearch"]);
	const dupey = readAt(config, ["dupey"]);
	const globalLanguages = listOf(readAt(config, ["languages"]));
	const rootLanguages = listOf(readAt(config, ["parserOptions", "languages"]));
	const ocrFallback = rootLanguages.length > 0 ? rootLanguages : globalLanguages.length > 0 ? globalLanguages : undefined;
	const webSearchDisabled = blockDisabled(webSearch);
	const fetchDisabled = webSearchDisabled || readAt(config, ["webSearch", "fetch"]) === false || blockDisabled(readAt(config, ["webSearch", "fetch"]));
	return (
		<>
			{heading("Other Apps", "웹 검색, 중복 제거, 파서와 데이터소스 접근 정책입니다.")}
			<BoolFieldRow snapshot={snapshot} path={["excludeExactDuplicates"]} name="Exclude exact duplicates" hint="동일 콘텐츠 중복을 최신 파일 중심으로 줄입니다." fallback onSaved={onSaved} />
			<Section title="Web search" description="웹 검색·가져오기 도구 설정입니다.">
				<BlockSwitchRow snapshot={snapshot} path={["webSearch"]} name="Enable web search" hint="web_search/web_fetch 도구를 사용합니다." mode="enabled" defaultEnabled onSaved={onSaved} />
				{webSearchDisabled ? null : renderFields(WEBSEARCH_FIELDS, snapshot, onSaved)}
				{webSearchDisabled ? null : (
					<>
						<BlockSwitchRow snapshot={snapshot} path={["webSearch", "fetch"]} name="Enable web fetch" hint="페이지 내용을 가져와 렌더링합니다." mode="enabled" defaultEnabled onSaved={onSaved} />
						{fetchDisabled ? null : renderFields(WEBFETCH_FIELDS, snapshot, onSaved)}
					</>
				)}
			</Section>
			<Section title="Dupey" description="버전 패밀리 중복 제거 도구입니다.">
				<BlockSwitchRow snapshot={snapshot} path={["dupey"]} name="Enable Dupey" hint="콘텐츠 버전 패밀리 스캔을 사용합니다." mode="enabled" defaultEnabled onSaved={onSaved} />
				{blockDisabled(dupey) ? null : renderFields(DUPEY_FIELDS, snapshot, onSaved)}
			</Section>
			<Section title="Parser and OCR" description="파서 언어 태그와 OCR/Kordoc 동작을 설정합니다.">
				<LanguageSettings snapshot={snapshot} path={["parserOptions", "languages"]} name="Parser languages" hint="parserOptions.languages — 설정하지 않으면 전역 languages를 상속합니다." onSaved={onSaved} fallback={globalLanguages.length > 0 ? globalLanguages : []} />
				{renderFields(PARSER_FIELDS, snapshot, onSaved)}
				<LanguageSettings snapshot={snapshot} path={["parserOptions", "ocr", "languages"]} name="OCR languages" hint="parserOptions.ocr.languages — 설정하지 않으면 parserOptions.languages/전역 languages를 상속합니다." onSaved={onSaved} fallback={ocrFallback ?? []} />
			</Section>
			<Section title="Datasource access" description="allowedTags와 allowedScopes는 default-deny 보안 경계입니다.">
				<ListFieldRow snapshot={snapshot} path={["datasourceAccess", "allowedTags"]} name="Allowed tags" hint="신뢰하는 데이터소스 스킬 태그를 한 줄에 하나씩 입력합니다." placeholder="notes\nwiki" onSaved={onSaved} />
				<ListFieldRow snapshot={snapshot} path={["datasourceAccess", "allowedScopes"]} name="Allowed scopes" hint="슬래시 계층 경로 또는 글로브를 한 줄에 하나씩 입력합니다." placeholder="team/**\npublic" onSaved={onSaved} />
			</Section>
		</>
	);
}
