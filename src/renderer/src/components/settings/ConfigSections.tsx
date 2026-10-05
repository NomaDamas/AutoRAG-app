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

import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
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

/**
 * Serialized config writer. Commits run one after another so a burst of
 * autosaves or a reset during an in-flight save never races on disk. Resolves
 * `true` when the batch landed, `false` when the backend rejected it, so a
 * caller can stop retrying a value that just failed.
 */
function useFieldCommit(onSaved: (next: AutoRagConfigSnapshot) => void): {
	readonly saving: boolean;
	readonly error: string | null;
	readonly setError: (message: string | null) => void;
	readonly commit: (ops: readonly AutoRagConfigUpdate[]) => Promise<boolean>;
} {
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const chainRef = useRef<Promise<void>>(Promise.resolve());
	const pendingRef = useRef(0);
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return (): void => {
			mountedRef.current = false;
		};
	}, []);
	const commit = useCallback(
		(ops: readonly AutoRagConfigUpdate[]): Promise<boolean> => {
			if (ops.length === 0) return Promise.resolve(true);
			pendingRef.current += 1;
			if (mountedRef.current) setSaving(true);
			const run = async (): Promise<boolean> => {
				if (mountedRef.current) setError(null);
				try {
					const next = await settings.configPatch(ops);
					onSaved(next);
					return true;
				} catch (cause) {
					if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause));
					return false;
				} finally {
					pendingRef.current -= 1;
					if (pendingRef.current === 0 && mountedRef.current) setSaving(false);
				}
			};
			const result = chainRef.current.then(run, run);
			chainRef.current = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		},
		[onSaved],
	);
	return { saving, error, setError, commit };
}

type DraftAttempt =
	| { readonly ops: readonly AutoRagConfigUpdate[] }
	| { readonly error: string };

/**
 * How a field maps between the stored JSON leaf and its editable string draft.
 * `*Signature` canonicalizes both sides so "unchanged" is decided on the value
 * that would actually be written, never on raw whitespace.
 */
interface DraftCodec {
	readonly serialize: (stored: JsonValue | undefined) => string;
	readonly storedSignature: (stored: JsonValue | undefined) => string;
	readonly draftSignature: (draft: string) => string;
	readonly build: (path: ConfigPath, draft: string) => DraftAttempt;
}

/** Debounce window for text/number/list edits before the implicit autosave. */
const AUTOSAVE_DELAY_MS = 300;

/**
 * Draft state for a non-boolean field: short-debounce autosave, blur/unmount
 * flush, serialized writes, unchanged-write guard, and no retry loop after a
 * validation or backend failure until the draft changes again.
 *
 * External snapshot updates adopt into the draft only when the draft has no
 * pending edits, so a save echo or a concurrent write to another leaf never
 * clobbers what the user is typing.
 */
function useDraftField(options: {
	readonly stored: JsonValue | undefined;
	readonly path: ConfigPath;
	readonly codec: DraftCodec;
	readonly onSaved: (next: AutoRagConfigSnapshot) => void;
	readonly enabled: boolean;
}): {
	readonly draft: string;
	readonly setDraft: (next: string) => void;
	readonly saving: boolean;
	readonly error: string | null;
	readonly flush: () => void;
	readonly reset: () => void;
} {
	const { stored, path, codec, onSaved, enabled } = options;
	const { saving, error, setError, commit } = useFieldCommit(onSaved);
	const storedSig = codec.storedSignature(stored);

	const [draft, setDraftState] = useState<string>(() => codec.serialize(stored));
	const draftRef = useRef(draft);
	const storedRef = useRef(stored);
	const codecRef = useRef(codec);
	const enabledRef = useRef(enabled);
	const pathRef = useRef(path);
	const storedSigRef = useRef(storedSig);
	const blockedRef = useRef<string | null>(null);
	const attemptedRef = useRef<string | null>(null);
	const timerRef = useRef<number | null>(null);
	const commitRef = useRef(commit);

	draftRef.current = draft;
	storedRef.current = stored;
	codecRef.current = codec;
	enabledRef.current = enabled;
	pathRef.current = path;
	commitRef.current = commit;

	const clearTimer = useCallback((): void => {
		if (timerRef.current !== null) {
			window.clearTimeout(timerRef.current);
			timerRef.current = null;
		}
	}, []);

	const setDraft = useCallback(
		(next: string): void => {
			draftRef.current = next;
			setDraftState(next);
			if (blockedRef.current !== null && codecRef.current.draftSignature(next) !== blockedRef.current) {
				blockedRef.current = null;
				setError(null);
			}
		},
		[setError],
	);

	// What would be written right now, or null when there is nothing new to write:
	// unchanged, disabled, a value that was already rejected, or a write already in
	// flight for the same signature. This is the single guard shared by the debounce
	// flush and the unmount flush, so a rejected value is never re-attempted unchanged.
	const resolvePending = useCallback((): { readonly sig: string; readonly attempt: DraftAttempt } | null => {
		if (!enabledRef.current) return null;
		const sig = codecRef.current.draftSignature(draftRef.current);
		const slot = codecRef.current.storedSignature(storedRef.current);
		const inFlight = attemptedRef.current;
		if (sig === slot) {
			// Nothing new — unless a stale in-flight write for another value may still
			// land and move disk away from this draft; then re-assert this draft after it.
			if (inFlight === null || inFlight === sig) return null;
		} else if (sig === blockedRef.current || sig === inFlight) {
			return null;
		}
		return { sig, attempt: codecRef.current.build(pathRef.current, draftRef.current) };
	}, []);

	const flush = useCallback((): void => {
		clearTimer();
		const resolved = resolvePending();
		if (resolved === null) return;
		if ("error" in resolved.attempt) {
			blockedRef.current = resolved.sig;
			setError(resolved.attempt.error);
			return;
		}
		attemptedRef.current = resolved.sig;
		void commitRef.current(resolved.attempt.ops).then((ok) => {
			if (!ok) {
				attemptedRef.current = null;
				blockedRef.current = resolved.sig;
			}
		});
	}, [clearTimer, resolvePending, setError]);

	const reset = useCallback((): void => {
		clearTimer();
		const next = codecRef.current.serialize(undefined);
		const nextSig = codecRef.current.draftSignature(next);
		draftRef.current = next;
		setDraftState(next);
		blockedRef.current = null;
		attemptedRef.current = nextSig;
		void commitRef.current([{ path: [...pathRef.current], remove: true }]).then((ok) => {
			if (ok) return;
			// The removal never landed: snap back to what is still on disk so the
			// control is truthful, and block a silent re-attempt until the user acts.
			attemptedRef.current = null;
			blockedRef.current = nextSig;
			const onDisk = codecRef.current.serialize(storedRef.current);
			draftRef.current = onDisk;
			setDraftState(onDisk);
		});
	}, [clearTimer]);

	// Snapshot updates. An echo of our own write never clobbers a newer draft — the
	// autosave below persists whatever the user last intended. External changes adopt
	// only when this draft has no pending user edit.
	useEffect(() => {
		const previous = storedSigRef.current;
		if (storedSig === previous) return;
		storedSigRef.current = storedSig;
		if (attemptedRef.current === storedSig) {
			attemptedRef.current = null;
			return;
		}
		// A write is still in flight: this update is an older echo or a racing write,
		// not a trustworthy external change. Keep the draft; the echo of the latest
		// write resolves it.
		if (attemptedRef.current !== null) return;
		if (codecRef.current.draftSignature(draftRef.current) !== previous) return;
		const next = codecRef.current.serialize(storedRef.current);
		draftRef.current = next;
		setDraftState(next);
	}, [storedSig]);

	// Debounced autosave. The guards skip unchanged, rejected, and in-flight drafts,
	// so no value is written on every render.
	useEffect(() => {
		if (!enabled) return;
		const sig = codecRef.current.draftSignature(draft);
		if (sig === storedSig || sig === blockedRef.current || sig === attemptedRef.current) return;
		const timer = window.setTimeout(flush, AUTOSAVE_DELAY_MS);
		timerRef.current = timer;
		return (): void => {
			if (timerRef.current === timer) {
				window.clearTimeout(timer);
				timerRef.current = null;
			}
		};
	}, [draft, storedSig, enabled, flush]);

	// Persist the latest draft when the row unmounts (category switch/collapse).
	// Depends only on stable callbacks, never on the per-render path array.
	useEffect(
		() => (): void => {
			clearTimer();
			const resolved = resolvePending();
			if (resolved === null || "error" in resolved.attempt) return;
			void commitRef.current(resolved.attempt.ops);
		},
		[clearTimer, resolvePending],
	);

	return { draft, setDraft, saving, error, flush, reset };
}

function normalizeList(draft: string): string[] {
	return draft
		.split(/\r?\n/u)
		.map((item) => item.trim())
		.filter(Boolean);
}

const TEXT_CODEC: DraftCodec = {
	serialize: (stored) => (typeof stored === "string" ? stored : ""),
	// An absent leaf and an explicit empty string both mean "default".
	storedSignature: (stored) => JSON.stringify(typeof stored === "string" ? stored : ""),
	draftSignature: (draft) => JSON.stringify(draft),
	build: (path, draft) => (draft.length === 0 ? { ops: [{ path: [...path], remove: true }] } : { ops: [{ path: [...path], value: draft }] }),
};

function isFiniteNumber(value: JsonValue | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function numberCodec(min: number | undefined, max: number | undefined): DraftCodec {
	return {
		serialize: (stored) => (isFiniteNumber(stored) ? String(stored) : ""),
		storedSignature: (stored) => JSON.stringify(isFiniteNumber(stored) ? stored : null),
		draftSignature: (draft) => {
			const trimmed = draft.trim();
			if (trimmed.length === 0) return JSON.stringify(null);
			const parsed = Number(trimmed);
			return Number.isFinite(parsed) ? JSON.stringify(parsed) : `invalid:${draft}`;
		},
		build: (path, draft) => {
			const trimmed = draft.trim();
			if (trimmed.length === 0) return { ops: [{ path: [...path], remove: true }] };
			const parsed = Number(trimmed);
			if (!Number.isFinite(parsed)) return { error: "숫자를 입력하세요." };
			if (min !== undefined && parsed < min) return { error: `최소값은 ${min}입니다.` };
			if (max !== undefined && parsed > max) return { error: `최대값은 ${max}입니다.` };
			return { ops: [{ path: [...path], value: parsed }] };
		},
	};
}

const LIST_CODEC: DraftCodec = {
	serialize: (stored) => listOf(stored).join("\n"),
	storedSignature: (stored) => JSON.stringify(listOf(stored)),
	draftSignature: (draft) => JSON.stringify(normalizeList(draft)),
	build: (path, draft) => {
		const values = normalizeList(draft);
		return values.length === 0 ? { ops: [{ path: [...path], remove: true }] } : { ops: [{ path: [...path], value: values }] };
	},
};

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
	const field = useDraftField({ stored, path, codec: TEXT_CODEC, onSaved, enabled: !disabled });
	return (
		<Row name={name} hint={hint}>
			<div className="settings-field-stack">
				<input className="settings-source-desc__input" aria-label={name} value={field.draft} placeholder={placeholder} disabled={disabled} onChange={(event) => field.setDraft(event.target.value)} onBlur={field.flush} />
				<div className="settings-field-actions">
					{field.saving ? <span className="settings-inline-status">저장 중…</span> : null}
					{stored !== undefined ? <ResetButton label={name} disabled={disabled || field.saving} onClick={field.reset} /> : null}
					{field.error ? <span className="settings-inline-error">{field.error}</span> : null}
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
	const field = useDraftField({ stored, path, codec: numberCodec(min, max), onSaved, enabled: !disabled });
	return (
		<Row name={name} hint={hint}>
			<div className="settings-field-stack">
				<input className="settings-source-desc__input" style={{ width: 180 }} type="number" aria-label={name} value={field.draft} placeholder={placeholder} disabled={disabled} onChange={(event) => field.setDraft(event.target.value)} onBlur={field.flush} />
				<div className="settings-field-actions">
					{field.saving ? <span className="settings-inline-status">저장 중…</span> : null}
					{stored !== undefined ? <ResetButton label={name} disabled={disabled || field.saving} onClick={field.reset} /> : null}
					{field.error ? <span className="settings-inline-error">{field.error}</span> : null}
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
		const option = allOptions.find((item) => item.key === key);
		if (option === undefined || option.key === "__custom__") return;
		if (JSON.stringify(option.value) === JSON.stringify(stored === undefined ? null : stored)) return;
		setDraft(key);
		void commit([option.value === null ? { path: [...path], remove: true } : { path: [...path], value: option.value as JsonValue }]).then((ok) => {
			// A failed write never happened on disk; snap the select back so the
			// control cannot show a value the config does not hold.
			if (!ok) setDraft(currentKey);
		});
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
	const field = useDraftField({ stored, path, codec: LIST_CODEC, onSaved, enabled: !disabled });
	return (
		<Row name={name} hint={hint}>
			<div className="settings-field-stack">
				<textarea className="linear-textarea" aria-label={name} rows={rows} value={field.draft} placeholder={placeholder} disabled={disabled} onChange={(event) => field.setDraft(event.target.value)} onBlur={field.flush} />
				<div className="settings-field-actions">
					{field.saving ? <span className="settings-inline-status">저장 중…</span> : null}
					{stored !== undefined ? <ResetButton label={name} disabled={disabled || field.saving} onClick={field.reset} /> : null}
					{field.error ? <span className="settings-inline-error">{field.error}</span> : null}
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
