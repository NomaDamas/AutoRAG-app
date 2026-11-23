/**
 * Settings → MCP 서버 (Figma 525:9533, 527:9672), in two directions: `McpConnectSection` lets other agents use
 * Dazzi's own MCP server, and the list below edits the agent's `mcp.json` through the `mcp*` bridge calls so
 * Dazzi can use other servers. The main process validates and keeps whatever this form does not manage
 * (`oauth`, `toolExposure`, …), so an entry written by hand survives an edit made here.
 */

import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { LocaleKey } from "../../../../shared/i18n/core";
import { Check, ChevronRight, ExternalLink, Globe, Info, KeyRound, Pencil, Plus, Terminal, TextAlignStart, Trash2, Wrench } from "lucide-react";
import type { JsonObject, JsonValue, McpExposure, McpServerRow, McpSnapshot } from "../../../../shared/settings-contract";
import { Switch } from "../primitives/Switch";
import { errorText } from "./configSupport";
import { McpConnectSection } from "./McpConnectSection";
import { ModalActions, ModalShell, PlainDivider, SettingsPageHead } from "./SettingsKit";
import { cn } from "../../lib/cn";
import { buttonClass } from "../primitives/button";

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

/** The faint line after the name: the address of a remote server, the command line of a local one. */
function targetOf(row: McpServerRow): string {
	const { config } = row;
	if (typeof config.url === "string") return config.url;
	return [typeof config.command === "string" ? config.command : "", ...stringList(config.args)].filter((part) => part.length > 0).join(" ");
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

	const openFile = async (): Promise<void> => {
		if (snapshot === null) return;
		try {
			await window.autorag.fs.open(snapshot.path);
			setError(null);
		} catch (cause) {
			setError(messageOf(cause));
		}
	};

	return (
		<>
			<SettingsPageHead title={t("settingsCore.mcp.title")} description={t("settingsCore.mcp.desc")} />
			{/* Figma 525:9533 / 527:9672: two titled groups ruled apart, like 일반; the server list is a card like 우클릭 메뉴's. */}
			<div className="plain-sections mcp-sections">
				<McpConnectSection />
				<PlainDivider />
				<section className="plain-section mcp-section" data-mcp-servers="true">
					<div className="cmenu-block">
						<h2 className="cmenu-block-title">{t("settingsCore.mcp.listTitle")}</h2>
						<p className="cmenu-block-desc">{t("settingsCore.mcp.listDesc")}</p>
					</div>
					{error !== null ? <div className="settings-error" role="alert">{error}</div> : null}
					{broken ? <div className="settings-error" role="alert">{`${t("settingsCore.mcp.fileError")} ${snapshot?.error ?? ""}`}</div> : null}
					<div className="mcp-servers">
						<p className="cmenu-note mcp-trust">
							<Info size={14} strokeWidth={1.5} aria-hidden="true" focusable="false" />
							<span>{t("settingsCore.mcp.trust")}</span>
						</p>
						<div className="sidebar-card" data-mcp-server-card="true">
							{snapshot !== null && snapshot.servers.length === 0 && !broken ? <p className="sidebar-card-empty is-compact">{t("settingsCore.mcp.empty")}</p> : null}
							{(snapshot?.servers ?? []).map((row) => {
								const target = targetOf(row);
								return (
									<div key={row.name} className={cn("sidebar-row mcp-server-row", !row.enabled && "is-muted")} data-mcp-server={row.name}>
										<span className="mcp-server-text">
											<span className="mcp-server-line">
												<span className="sidebar-row-name">{row.name}</span>
												<span className="sidebar-always-badge is-plain">{t(transportLabel(row))}</span>
												{target.length > 0 ? (
													<span className="sidebar-row-path" title={target}>
														{target}
													</span>
												) : null}
											</span>
											{row.problem !== null ? <span className="mcp-server-problem">{row.problem}</span> : null}
										</span>
										<button type="button" className="shortcuts-reset" data-action={`edit-mcp-${row.name}`} aria-label={`${t("settingsCore.mcp.edit")}: ${row.name}`} title={t("settingsCore.mcp.edit")} disabled={broken} onClick={() => setEditing({ row })}>
											<Pencil size={14} strokeWidth={1.5} aria-hidden="true" focusable="false" />
										</button>
										<button type="button" className="shortcuts-reset" data-action={`remove-mcp-${row.name}`} aria-label={`${t("settingsCore.mcp.remove")}: ${row.name}`} title={t("settingsCore.mcp.remove")} disabled={broken} onClick={() => setRemoving(row)}>
											<Trash2 size={14} strokeWidth={1.5} aria-hidden="true" focusable="false" />
										</button>
										<Switch
											checked={row.enabled}
											disabled={broken}
											ariaLabel={t("settingsCore.mcp.enabledAria", { name: row.name })}
											onChange={() => void change(() => settings.mcpUpsert({ name: row.name, replaces: row.name, config: withSwitches(row.config, { enabled: !row.enabled }) }))}
										/>
									</div>
								);
							})}
							<div className="sidebar-row is-add mcp-add-row">
								<button type="button" className={cn(buttonClass({ size: "sm" }), "shortcuts-outline-btn")} data-action="add-mcp-server" disabled={broken || snapshot === null} onClick={() => setEditing({ row: null })}>
									<Plus aria-hidden="true" />
									{t("settingsCore.mcp.add")}
								</button>
								<span className="sidebar-row-spacer" />
								{snapshot?.exists === true ? (
									<button type="button" className={cn(buttonClass({ size: "sm" }), "shortcuts-outline-btn")} data-action="open-mcp-config" title={snapshot.path} onClick={() => void openFile()}>
										<ExternalLink aria-hidden="true" />
										{t("settingsCore.mcp.openFile")}
									</button>
								) : null}
							</div>
						</div>
					</div>
				</section>
			</div>
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
				// Figma 580:15140 (중요 알림): a small card; 삭제 is the blue "yes", not a red button.
				<ModalShell className="settings-alert" onClose={() => setRemoving(null)} label={t("settingsCore.mcp.modal.removeTitle", { name: removing.name })}>
					<h2>{t("settingsCore.mcp.modal.removeTitle", { name: removing.name })}</h2>
					<p>{t("settingsCore.mcp.modal.removeBody")}</p>
					<ModalActions>
						<button type="button" className="linear-btn" onClick={() => setRemoving(null)}>{t("common.cancel")}</button>
						<button
							type="button"
							className="linear-btn settings-btn-primary"
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

/** The names a `NAME=value` (or `Name: value`) block sets, for a row's one-line summary. */
function keysOf(text: string, separator: "=" | ":"): readonly string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => line.split(separator)[0]!.trim())
		.filter((key) => key.length > 0);
}

/**
 * MCP 서버 추가/수정, in the 매직 액션 만들기 format (Figma 598:3131): the name as the title, 연결 방식 as a
 * segmented control, what it runs on the grey card, then one list of rows for 환경 변수 (or 헤더), the tool
 * exposure and the description.
 */
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
	// How the server's tools reach the model; set here now that the list rows only carry the on/off switch.
	const [exposure, setExposure] = useState<McpExposure>(row?.exposure ?? "codemode");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const set = (patch: Partial<FormState>): void => setForm((current) => ({ ...current, ...patch }));
	const target = form.kind === "http" ? form.url.trim() : form.command.trim();
	const hasOwnSettings = row !== null && Object.keys(row.config).some((key) => !MANAGED_KEYS.includes(key) && key !== "enabled" && key !== "exposure");
	// A row starts open only when editing a server that already uses it.
	const [initialOpen] = useState(() => ({
		vars: row !== null && (form.env.trim() !== "" || form.headers.trim() !== ""),
		exposure: row !== null && exposure !== "codemode",
		description: row !== null && form.description.trim() !== "",
	}));

	async function submit(): Promise<void> {
		const built = configFrom(form, row?.config ?? null);
		if ("badLine" in built) {
			setError(t("settingsCore.mcp.modal.badLine", { line: built.badLine }));
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await onSave(form.name.trim(), withSwitches(built.config, { exposure }));
		} catch (cause) {
			setError(messageOf(cause));
			setBusy(false);
		}
	}

	const isStdio = form.kind === "stdio";
	const varKeys = isStdio ? keysOf(form.env, "=") : keysOf(form.headers, ":");
	const none = t("settingsCore.mcp.modal.noneValue");
	const HeaderIcon = isStdio ? Terminal : Globe;

	return (
		<ModalShell className="magic-editor-modal" onClose={onClose} label={row === null ? t("settingsCore.mcp.modal.addTitle") : t("settingsCore.mcp.modal.editTitle")}>
			<div className="magic-editor" data-testid="mcp-server-modal">
				<div className="magic-editor-head">
					<span className="magic-editor-tile" aria-hidden="true">
						<HeaderIcon size={20} />
					</span>
					<div className="magic-editor-name">
						<input
							autoFocus
							aria-label={t("settingsCore.mcp.modal.name")}
							value={form.name}
							placeholder={t("settingsCore.mcp.modal.namePlaceholder")}
							onChange={(event) => set({ name: event.target.value })}
						/>
						<span>{t("settingsCore.mcp.modal.nameHint")}</span>
					</div>
				</div>

				<div className="magic-editor-kind">
					<span className="magic-editor-caption">{t("settingsCore.mcp.modal.kind")}</span>
					<div className="magic-editor-seg" role="radiogroup" aria-label={t("settingsCore.mcp.modal.kind")}>
						{(
							[
								{ value: "stdio", label: t("settingsCore.mcp.modal.kindStdio"), Icon: Terminal },
								{ value: "http", label: t("settingsCore.mcp.modal.kindHttp"), Icon: Globe },
							] as const
						).map((option) => (
							<button
								key={option.value}
								type="button"
								role="radio"
								aria-checked={form.kind === option.value}
								className={cn(form.kind === option.value && "is-active")}
								data-testid={`mcp-kind-${option.value}`}
								onClick={() => set({ kind: option.value })}
							>
								<option.Icon size={14} aria-hidden="true" />
								{option.label}
							</button>
						))}
					</div>
				</div>

				<div className="magic-editor-card mcp-editor-card">
					{isStdio ? (
						<>
							<label className="mcp-editor-line">
								<span className="magic-editor-caption">{t("settingsCore.mcp.modal.command")}</span>
								<input className="is-mono" value={form.command} placeholder={t("settingsCore.mcp.modal.commandPlaceholder")} onChange={(event) => set({ command: event.target.value })} />
							</label>
							<label className="mcp-editor-line">
								<span className="magic-editor-caption">{t("settingsCore.mcp.modal.args")}</span>
								<textarea className="is-mono" rows={3} value={form.args} placeholder={t("settingsCore.mcp.modal.argsPlaceholder")} onChange={(event) => set({ args: event.target.value })} />
								<small>{t("settingsCore.mcp.modal.argsHint")}</small>
							</label>
						</>
					) : (
						<label className="mcp-editor-line">
							<span className="magic-editor-caption">{t("settingsCore.mcp.modal.url")}</span>
							<input className="is-mono" value={form.url} placeholder={t("settingsCore.mcp.modal.urlPlaceholder")} onChange={(event) => set({ url: event.target.value })} />
						</label>
					)}
				</div>

				<div className="magic-editor-group">
					<details className="magic-editor-section" data-mcp-section="vars" open={initialOpen.vars}>
						<summary>
							<KeyRound size={16} aria-hidden="true" />
							<span className="magic-editor-section-name">{t(isStdio ? "settingsCore.mcp.modal.envRow" : "settingsCore.mcp.modal.headersRow")}</span>
							<span className="magic-editor-section-value">{varKeys.length > 0 ? varKeys.join(", ") : none}</span>
							<ChevronRight size={14} aria-hidden="true" className="magic-editor-section-chevron" />
						</summary>
						<div className="magic-editor-sub">
							<label className="magic-editor-field">
								<textarea
									className="is-mono"
									rows={3}
									aria-label={t(isStdio ? "settingsCore.mcp.modal.env" : "settingsCore.mcp.modal.headers")}
									value={isStdio ? form.env : form.headers}
									placeholder={t(isStdio ? "settingsCore.mcp.modal.envPlaceholder" : "settingsCore.mcp.modal.headersPlaceholder")}
									onChange={(event) => set(isStdio ? { env: event.target.value } : { headers: event.target.value })}
								/>
								<small>{t(isStdio ? "settingsCore.mcp.modal.envFormatHint" : "settingsCore.mcp.modal.headersFormatHint")}</small>
							</label>
						</div>
					</details>
					<details className="magic-editor-section" data-mcp-section="exposure" open={initialOpen.exposure}>
						<summary>
							<Wrench size={16} aria-hidden="true" />
							<span className="magic-editor-section-name">{t("settingsCore.mcp.exposureLabel")}</span>
							<span className="magic-editor-section-value">{t(`settingsCore.mcp.exposure.${exposure}`)}</span>
							<ChevronRight size={14} aria-hidden="true" className="magic-editor-section-chevron" />
						</summary>
						<div className="magic-editor-sub">
							<div className="mcp-editor-choices" role="radiogroup" aria-label={t("settingsCore.mcp.exposureLabel")}>
								{EXPOSURES.map((value) => (
									<button
										key={value}
										type="button"
										role="radio"
										aria-checked={exposure === value}
										data-testid={`mcp-exposure-${value}`}
										onClick={() => setExposure(value)}
									>
										<span className="magic-editor-switch-text">
											<span>{t(`settingsCore.mcp.exposure.${value}`)}</span>
											<small>{t(`settingsCore.mcp.exposureHint.${value}`)}</small>
										</span>
										{exposure === value ? <Check size={14} aria-hidden="true" /> : null}
									</button>
								))}
							</div>
						</div>
					</details>
					<details className="magic-editor-section" data-mcp-section="description" open={initialOpen.description}>
						<summary>
							<TextAlignStart size={16} aria-hidden="true" />
							<span className="magic-editor-section-name">{t("settingsCore.mcp.modal.description")}</span>
							<span className="magic-editor-section-value">{form.description.trim() !== "" ? form.description.trim() : none}</span>
							<ChevronRight size={14} aria-hidden="true" className="magic-editor-section-chevron" />
						</summary>
						<div className="magic-editor-sub">
							<label className="magic-editor-field">
								<input aria-label={t("settingsCore.mcp.modal.description")} value={form.description} onChange={(event) => set({ description: event.target.value })} />
								<small>{t("settingsCore.mcp.modal.descriptionHint")}</small>
							</label>
						</div>
					</details>
				</div>

				{hasOwnSettings ? <p className="settings-modal-note mcp-editor-note">{t("settingsCore.mcp.modal.advanced")}</p> : null}
				{error !== null ? <p className="settings-modal-error mcp-editor-note">{error}</p> : null}
				<ModalActions>
					<button type="button" className="linear-btn" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
					<button type="button" className="linear-btn settings-btn-primary" disabled={busy || form.name.trim().length === 0 || target.length === 0} onClick={() => void submit()}>
						{t("settingsCore.mcp.modal.save")}
					</button>
				</ModalActions>
			</div>
		</ModalShell>
	);
}
