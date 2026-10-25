/**
 * Settings → MCP 서버, in two directions: `McpConnectSection` lets other agents use Dazzi's own MCP server,
 * and the list below edits the agent's `mcp.json` through the `mcp*` bridge calls so Dazzi can use
 * other servers. The main process validates and keeps whatever this form does not manage
 * (`oauth`, `toolExposure`, …), so an entry written by hand survives an edit made here.
 */

import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { LocaleKey } from "../../../../shared/i18n/core";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { JsonObject, JsonValue, McpExposure, McpServerRow, McpSnapshot } from "../../../../shared/settings-contract";
import { Switch } from "../primitives/Switch";
import { errorText } from "./configSupport";
import { McpConnectSection } from "./McpConnectSection";
import { ModalActions, ModalShell, Note, Row, Section, SettingsPageHead, StatusDot } from "./SettingsKit";

const settings = window.autorag.settings;

/** Electron wraps a handler's error as "Error invoking remote method 'x': Error: <message>"; show only the message. */
function messageOf(cause: unknown): string {
	return errorText(cause).replace(/^Error invoking remote method '[^']*': (?:Error: )?/u, "");
}

const EXPOSURES: readonly McpExposure[] = ["codemode", "deferred", "direct", "hidden"];

/** Keys the form owns; everything else in an entry is carried over untouched. */
const MANAGED_KEYS: readonly string[] = ["type", "command", "args", "env", "cwd", "url", "headers", "description"];

type Kind = "stdio" | "http";

interface FormState {
	readonly name: string;
	readonly kind: Kind;
	readonly command: string;
	readonly args: string;
	readonly env: string;
	readonly url: string;
	readonly headers: string;
	readonly description: string;
}

const EMPTY_FORM: FormState = { name: "", kind: "stdio", command: "", args: "", env: "", url: "", headers: "", description: "" };

function stringList(value: JsonValue | undefined): readonly string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function recordLines(value: JsonValue | undefined, separator: string): string {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.entries(value as JsonObject)
				.filter((entry): entry is [string, string] => typeof entry[1] === "string")
				.map(([key, entry]) => `${key}${separator}${entry}`)
				.join("\n")
		: "";
}

function formOf(row: McpServerRow): FormState {
	const { config } = row;
	return {
		name: row.name,
		kind: row.transport === "http" ? "http" : "stdio",
		command: typeof config.command === "string" ? config.command : "",
		args: stringList(config.args).join("\n"),
		env: recordLines(config.env, "="),
		url: typeof config.url === "string" ? config.url : "",
		headers: recordLines(config.headers, ": "),
		description: typeof config.description === "string" ? config.description : "",
	};
}

/** `NAME=value` or `Name: value` lines into a record; null names the first line that has no separator. */
function parseRecord(text: string, separator: string): { readonly value: Record<string, string> } | { readonly badLine: string } {
	const value: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		const at = trimmed.indexOf(separator);
		if (at <= 0) return { badLine: trimmed };
		value[trimmed.slice(0, at).trim()] = trimmed.slice(at + separator.length).trim();
	}
	return { value };
}

/** The entry to store: the previous one minus what the form owns, plus what the form says. */
function configFrom(form: FormState, previous: JsonObject | null): { readonly config: JsonObject } | { readonly badLine: string } {
	const kept = Object.fromEntries(Object.entries(previous ?? {}).filter(([key]) => !MANAGED_KEYS.includes(key))) as Record<string, JsonValue>;
	const description = form.description.trim();
	if (description.length > 0) kept.description = description;
	if (form.kind === "http") {
		const headers = parseRecord(form.headers, ":");
		if ("badLine" in headers) return headers;
		kept.url = form.url.trim();
		if (Object.keys(headers.value).length > 0) kept.headers = headers.value;
		return { config: kept };
	}
	const env = parseRecord(form.env, "=");
	if ("badLine" in env) return env;
	kept.command = form.command.trim();
	const args = form.args.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
	if (args.length > 0) kept.args = args;
	if (Object.keys(env.value).length > 0) kept.env = env.value;
	// `cwd` is not on the form, but it belongs to a command entry: keep it.
	if (typeof previous?.cwd === "string") kept.cwd = previous.cwd;
	return { config: kept };
}

/** The same entry with `enabled` / `exposure` set; the defaults remove the key, like pi's own `/mcp`. */
function withSwitches(config: JsonObject, patch: { readonly enabled?: boolean; readonly exposure?: McpExposure }): JsonObject {
	const next: Record<string, JsonValue> = { ...config };
	if (patch.enabled !== undefined) {
		if (patch.enabled) delete next.enabled;
		else next.enabled = false;
	}
	if (patch.exposure !== undefined) {
		if (patch.exposure === "codemode") delete next.exposure;
		else next.exposure = patch.exposure;
	}
	return next;
}

function transportLabel(row: McpServerRow): LocaleKey {
	return row.transport === "stdio" ? "settingsCore.mcp.transportStdio" : row.transport === "http" ? "settingsCore.mcp.transportHttp" : "settingsCore.mcp.transportUnknown";
}

export function McpPage(): ReactElement {
	const { t } = useTranslation();
	const [snapshot, setSnapshot] = useState<McpSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [editing, setEditing] = useState<{ readonly row: McpServerRow | null } | null>(null);
	const [removing, setRemoving] = useState<McpServerRow | null>(null);

	const load = useCallback(async (): Promise<void> => {
		try {
			setSnapshot(await settings.mcpGet());
			setError(null);
		} catch (cause) {
			setError(messageOf(cause));
		}
	}, []);
	useEffect(() => {
		void load();
	}, [load]);

	const change = async (work: () => Promise<McpSnapshot>): Promise<void> => {
		try {
			setSnapshot(await work());
			setError(null);
		} catch (cause) {
			setError(messageOf(cause));
			await load();
		}
	};

	const broken = snapshot?.error != null;

	return (
		<>
			<SettingsPageHead title={t("settingsCore.mcp.title")} description={t("settingsCore.mcp.desc")} />
			<McpConnectSection />
			{error !== null ? <div className="settings-error" role="alert">{error}</div> : null}
			{broken ? <div className="settings-error" role="alert">{`${t("settingsCore.mcp.fileError")} ${snapshot?.error ?? ""}`}</div> : null}
			<Section title={t("settingsCore.mcp.listTitle")} description={t("settingsCore.mcp.listDesc")}>
				<Note>{t("settingsCore.mcp.trust")}</Note>
				{snapshot !== null && snapshot.servers.length === 0 && !broken ? <p className="linear-section-desc">{t("settingsCore.mcp.empty")}</p> : null}
				{(snapshot?.servers ?? []).map((row) => (
					<div key={row.name} className="settings-list-row" data-mcp-server={row.name}>
						<span className="settings-list-body">
							<span className="settings-list-title">{row.name}</span>
							<span className="settings-list-meta">
								{[t(transportLabel(row)), t(`settingsCore.mcp.exposure.${row.exposure}`), row.problem === null ? null : `${t("settingsCore.mcp.problem")}: ${row.problem}`].filter((part) => part !== null).join(" · ")}
							</span>
						</span>
						<span className="settings-status">
							<StatusDot tone={row.problem !== null ? "warn" : row.enabled && row.exposure !== "hidden" ? "ok" : "off"} />
							{row.enabled ? t("settingsCore.mcp.on") : t("settingsCore.mcp.off")}
						</span>
						<select
							className="linear-select"
							aria-label={t("settingsCore.mcp.exposureLabel")}
							title={t(`settingsCore.mcp.exposureHint.${row.exposure}`)}
							value={row.exposure}
							disabled={broken}
							onChange={(event) => void change(() => settings.mcpUpsert({ name: row.name, replaces: row.name, config: withSwitches(row.config, { exposure: event.target.value as McpExposure }) }))}
						>
							{EXPOSURES.map((exposure) => (
								<option key={exposure} value={exposure}>{t(`settingsCore.mcp.exposure.${exposure}`)}</option>
							))}
						</select>
						<Switch
							checked={row.enabled}
							disabled={broken}
							ariaLabel={t("settingsCore.mcp.enabledAria", { name: row.name })}
							onChange={() => void change(() => settings.mcpUpsert({ name: row.name, replaces: row.name, config: withSwitches(row.config, { enabled: !row.enabled }) }))}
						/>
						<button type="button" className="linear-btn" aria-label={t("settingsCore.mcp.edit")} title={t("settingsCore.mcp.edit")} disabled={broken} onClick={() => setEditing({ row })}>
							<Pencil size={14} aria-hidden="true" focusable="false" />
						</button>
						<button type="button" className="linear-btn" aria-label={t("settingsCore.mcp.remove")} title={t("settingsCore.mcp.remove")} disabled={broken} onClick={() => setRemoving(row)}>
							<Trash2 size={14} aria-hidden="true" focusable="false" />
						</button>
					</div>
				))}
				<Row name={t("settingsCore.mcp.add")} hint={snapshot === null ? "" : t("settingsCore.mcp.file", { path: snapshot.path })}>
					<button type="button" className="linear-btn settings-btn-primary" disabled={broken || snapshot === null} onClick={() => setEditing({ row: null })}>
						<Plus size={14} aria-hidden="true" focusable="false" /> {t("settingsCore.mcp.add")}
					</button>
				</Row>
			</Section>
			{editing !== null ? (
				<ServerModal
					row={editing.row}
					onClose={() => setEditing(null)}
					onSave={async (name, config) => {
						const next = await settings.mcpUpsert({ name, config, ...(editing.row === null ? {} : { replaces: editing.row.name }) });
						setSnapshot(next);
						setError(null);
						setEditing(null);
					}}
				/>
			) : null}
			{removing !== null ? (
				<ModalShell onClose={() => setRemoving(null)}>
					<h2>{t("settingsCore.mcp.modal.removeTitle", { name: removing.name })}</h2>
					<p>{t("settingsCore.mcp.modal.removeBody")}</p>
					<ModalActions>
						<button type="button" className="linear-btn" onClick={() => setRemoving(null)}>{t("common.cancel")}</button>
						<button
							type="button"
							className="linear-btn is-danger"
							onClick={() => {
								const target = removing;
								setRemoving(null);
								void change(() => settings.mcpRemove(target.name));
							}}
						>
							{t("settingsCore.mcp.remove")}
						</button>
					</ModalActions>
				</ModalShell>
			) : null}
		</>
	);
}

function ServerModal({
	row,
	onClose,
	onSave,
}: {
	readonly row: McpServerRow | null;
	readonly onClose: () => void;
	readonly onSave: (name: string, config: JsonObject) => Promise<void>;
}): ReactElement {
	const { t } = useTranslation();
	const [form, setForm] = useState<FormState>(row === null ? EMPTY_FORM : formOf(row));
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const set = (patch: Partial<FormState>): void => setForm((current) => ({ ...current, ...patch }));
	const target = form.kind === "http" ? form.url.trim() : form.command.trim();
	const hasOwnSettings = row !== null && Object.keys(row.config).some((key) => !MANAGED_KEYS.includes(key) && key !== "enabled" && key !== "exposure");

	async function submit(): Promise<void> {
		const built = configFrom(form, row?.config ?? null);
		if ("badLine" in built) {
			setError(t("settingsCore.mcp.modal.badLine", { line: built.badLine }));
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await onSave(form.name.trim(), built.config);
		} catch (cause) {
			setError(messageOf(cause));
			setBusy(false);
		}
	}

	return (
		<ModalShell onClose={onClose}>
			<h2>{row === null ? t("settingsCore.mcp.modal.addTitle") : t("settingsCore.mcp.modal.editTitle")}</h2>
			<label>
				{t("settingsCore.mcp.modal.name")}
				<input autoFocus value={form.name} placeholder={t("settingsCore.mcp.modal.namePlaceholder")} onChange={(event) => set({ name: event.target.value })} />
			</label>
			<label>
				{t("settingsCore.mcp.modal.kind")}
				<select className="linear-select" value={form.kind} onChange={(event) => set({ kind: event.target.value as Kind })}>
					<option value="stdio">{t("settingsCore.mcp.modal.kindStdio")}</option>
					<option value="http">{t("settingsCore.mcp.modal.kindHttp")}</option>
				</select>
			</label>
			{form.kind === "stdio" ? (
				<>
					<label>
						{t("settingsCore.mcp.modal.command")}
						<input value={form.command} placeholder={t("settingsCore.mcp.modal.commandPlaceholder")} onChange={(event) => set({ command: event.target.value })} />
					</label>
					<label>
						{t("settingsCore.mcp.modal.args")}
						<textarea rows={3} value={form.args} onChange={(event) => set({ args: event.target.value })} />
					</label>
					<label>
						{t("settingsCore.mcp.modal.env")}
						<textarea rows={2} value={form.env} onChange={(event) => set({ env: event.target.value })} />
						<small>{t("settingsCore.mcp.modal.envHint")}</small>
					</label>
				</>
			) : (
				<>
					<label>
						{t("settingsCore.mcp.modal.url")}
						<input value={form.url} placeholder={t("settingsCore.mcp.modal.urlPlaceholder")} onChange={(event) => set({ url: event.target.value })} />
					</label>
					<label>
						{t("settingsCore.mcp.modal.headers")}
						<textarea rows={2} value={form.headers} onChange={(event) => set({ headers: event.target.value })} />
						<small>{t("settingsCore.mcp.modal.envHint")}</small>
					</label>
				</>
			)}
			<label>
				{t("settingsCore.mcp.modal.description")}
				<input value={form.description} onChange={(event) => set({ description: event.target.value })} />
			</label>
			{hasOwnSettings ? <p className="settings-modal-note">{t("settingsCore.mcp.modal.advanced")}</p> : null}
			{error !== null ? <p className="settings-modal-error">{error}</p> : null}
			<ModalActions>
				<button type="button" className="linear-btn" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
				<button type="button" className="linear-btn settings-btn-primary" disabled={busy || form.name.trim().length === 0 || target.length === 0} onClick={() => void submit()}>
					{t("settingsCore.mcp.modal.save")}
				</button>
			</ModalActions>
		</ModalShell>
	);
}
