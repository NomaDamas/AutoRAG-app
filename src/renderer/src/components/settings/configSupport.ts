/**
 * Shared AutoRAG-config readers and a serialized writer for the prototype
 * Settings pages.
 *
 * The readers mirror the ones the typed config sections use (a config value is
 * read without throwing on a missing/wrong-typed leaf); the writer runs leaf-level
 * `configPatch` batches one after another so a burst of toggles never races on
 * disk, and reports the backend error instead of dropping it.
 */

import { useCallback, useRef, useState } from "react";
import type { AutoRagConfigSnapshot, AutoRagConfigUpdate, JsonObject, JsonValue } from "../../../../shared/settings-contract";
import { isJsonObject } from "../../../../shared/settings-contract";

const settings = window.autorag.settings;

export function getAt(root: JsonObject, path: readonly string[]): JsonValue | undefined {
	let current: JsonValue | undefined = root;
	for (const segment of path) {
		if (current === undefined || !isJsonObject(current)) return undefined;
		current = (current as JsonObject)[segment];
	}
	return current;
}

export function asRecord(value: JsonValue | undefined): JsonObject | null {
	return value !== undefined && isJsonObject(value) ? (value as JsonObject) : null;
}

export function stringOf(value: JsonValue | undefined): string {
	return typeof value === "string" ? value : "";
}

export function boolOf(value: JsonValue | undefined): boolean | null {
	return typeof value === "boolean" ? value : null;
}

export function numberOf(value: JsonValue | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function listOf(value: JsonValue | undefined): readonly string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Wire protocols accepted by the shared AutoRAG config for `model.api` (upstream
 * `AGENT_MODEL_APIS`). Other Pi catalog protocols (e.g. google-generative-ai)
 * are supported by omitting `api` and letting the catalog model supply its own
 * transport — the config `api` is only an override and must be one of these.
 */
const ALLOWED_AGENT_APIS: readonly string[] = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"openai-codex-responses",
	"azure-openai-responses",
];

export function isAllowedAgentApi(api: string): boolean {
	return ALLOWED_AGENT_APIS.includes(api);
}

/** Default API-key env-var name for a provider id (`foo-bar` → `FOO_BAR_API_KEY`). */
export function defaultEnvName(provider: string): string {
	const base = provider.replace(/[^A-Za-z0-9]/gu, "_").toUpperCase();
	return base.length === 0 ? "" : `${base}_API_KEY`;
}

/** Commit batched leaf writes, serialized, surfacing the first failure. */
export function useConfigWriter(onSaved: (next: AutoRagConfigSnapshot) => void): {
	readonly saving: boolean;
	readonly error: string | null;
	readonly clearError: () => void;
	readonly run: (ops: readonly AutoRagConfigUpdate[]) => Promise<void>;
} {
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const chain = useRef<Promise<void>>(Promise.resolve());
	const pending = useRef(0);
	const run = useCallback(
		(ops: readonly AutoRagConfigUpdate[]): Promise<void> => {
			if (ops.length === 0) return Promise.resolve();
			pending.current += 1;
			setSaving(true);
			const task = chain.current.then(async () => {
				try {
					onSaved(await settings.configPatch(ops));
					setError(null);
				} catch (cause) {
					setError(errorText(cause));
				}
			});
			chain.current = task;
			return task.finally(() => {
				pending.current -= 1;
				if (pending.current === 0) setSaving(false);
			});
		},
		[onSaved],
	);
	const clearError = useCallback((): void => setError(null), []);
	return { saving, error, clearError, run };
}
