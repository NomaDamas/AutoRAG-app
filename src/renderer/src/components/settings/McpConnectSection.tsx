/**
 * Settings → MCP 서버 → "다른 에이전트에 연결".
 *
 * Dazzi's own MCP server is what Claude Code, Codex, Gemini CLI, Cursor and the like start to search the
 * documents Dazzi indexed. The main process resolves how to start it (`mcpConnectInfo`); this section turns that
 * into the text each agent wants and lets the user copy it with one click.
 */

import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";
import type { McpConnectInfo } from "../../../../shared/settings-contract";
import { MCP_SERVER_NAME, clientSnippet, envLines, withReadOnly, type McpClientId } from "../../../../shared/mcp-connect";
import { Switch } from "../primitives/Switch";
import { errorText } from "./configSupport";
import { Row, Section } from "./SettingsKit";

const settings = window.autorag.settings;

/** How long the "copied" confirmation stays before the button reads "copy" again. */
const COPIED_MS = 1800;

type Tab = McpClientId | "manual";

/** Agent names are brand names and are not translated; only the manual tab is a phrase. */
const TABS: readonly { readonly id: Tab; readonly brand: string | null }[] = [
	{ id: "claude", brand: "Claude Code" },
	{ id: "codex", brand: "Codex" },
	{ id: "gemini", brand: "Gemini CLI" },
	{ id: "json", brand: "JSON" },
	{ id: "manual", brand: null },
];

/** Which copy button was pressed last, for a moment: a snippet, or one field of the manual tab. */
function useCopy(): { readonly copied: string | null; readonly failed: boolean; readonly copy: (key: string, text: string) => Promise<void> } {
	const [copied, setCopied] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	const timer = useRef<number | null>(null);
	useEffect(
		() => () => {
			if (timer.current !== null) window.clearTimeout(timer.current);
		},
		[],
	);
	const copy = async (key: string, text: string): Promise<void> => {
		try {
			await navigator.clipboard.writeText(text);
			setFailed(false);
			setCopied(key);
		} catch {
			setCopied(null);
			setFailed(true);
			return;
		}
		if (timer.current !== null) window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() => setCopied(null), COPIED_MS);
	};
	return { copied, failed, copy };
}

function CopyMark({ done }: { readonly done: boolean }): ReactElement {
	const { t } = useTranslation();
	return (
		<span className={`settings-copy-mark${done ? " is-done" : ""}`}>
			{done ? <Check size={13} aria-hidden="true" focusable="false" /> : <Copy size={13} aria-hidden="true" focusable="false" />}
			{done ? t("settingsCore.mcp.connect.copied") : t("settingsCore.mcp.connect.copy")}
		</span>
	);
}

export function McpConnectSection(): ReactElement {
	const { t } = useTranslation();
	const [info, setInfo] = useState<McpConnectInfo | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [tab, setTab] = useState<Tab>("claude");
	const [readOnly, setReadOnly] = useState(false);
	const { copied, failed, copy } = useCopy();
	const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

	useEffect(() => {
		settings.mcpConnectInfo().then(setInfo, (cause: unknown) => setError(errorText(cause)));
	}, []);

	const moveTab = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
		const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
		if (step === 0) return;
		event.preventDefault();
		const next = TABS[(index + step + TABS.length) % TABS.length];
		if (next === undefined) return;
		setTab(next.id);
		tabRefs.current[next.id]?.focus();
	};

	const launch = info === null ? null : withReadOnly(info, readOnly);
	const snippet = info === null || launch === null || tab === "manual" ? null : clientSnippet(tab, launch, info.platform);
	const fields =
		launch === null
			? []
			: [
					{ key: "name", label: t("settingsCore.mcp.connect.field.name"), value: MCP_SERVER_NAME },
					{ key: "transport", label: t("settingsCore.mcp.connect.field.transport"), value: "stdio" },
					{ key: "command", label: t("settingsCore.mcp.connect.field.command"), value: launch.command },
					{ key: "args", label: t("settingsCore.mcp.connect.field.args"), value: launch.args.join("\n") },
					{ key: "env", label: t("settingsCore.mcp.connect.field.env"), value: envLines(launch) },
				].filter((field) => field.value.length > 0);

	return (
		<Section title={t("settingsCore.mcp.connect.title")} description={t("settingsCore.mcp.connect.desc")}>
			{error !== null ? <div className="settings-error" role="alert">{error}</div> : null}
			{info !== null && !info.available ? <div className="settings-error" role="alert">{t("settingsCore.mcp.connect.unavailable")}</div> : null}
			{info !== null && info.available ? (
				<>
					<div className="settings-seg" role="tablist" aria-label={t("settingsCore.mcp.connect.tabsAria")}>
						{TABS.map((entry, index) => (
							<button
								key={entry.id}
								ref={(node) => {
									tabRefs.current[entry.id] = node;
								}}
								type="button"
								role="tab"
								id={`mcp-connect-tab-${entry.id}`}
								aria-selected={tab === entry.id}
								aria-controls="mcp-connect-panel"
								tabIndex={tab === entry.id ? 0 : -1}
								className={`settings-seg-item${tab === entry.id ? " is-active" : ""}`}
								onClick={() => setTab(entry.id)}
								onKeyDown={(event) => moveTab(event, index)}
							>
								{entry.brand ?? t("settingsCore.mcp.connect.tabManual")}
							</button>
						))}
					</div>
					<div id="mcp-connect-panel" role="tabpanel" aria-labelledby={`mcp-connect-tab-${tab}`}>
						{snippet !== null ? (
							<>
								{/* Clicking the text copies it too, unless the click ends a drag that selected some of it. */}
								<pre
									className="settings-snippet"
									data-mcp-snippet={tab}
									onClick={() => {
										if ((window.getSelection()?.toString() ?? "").length === 0) void copy(tab, snippet);
									}}
								>
									<code>{snippet}</code>
								</pre>
								<div className="settings-snippet-foot">
									<span className="settings-snippet-hint">{t(tab === "json" ? "settingsCore.mcp.connect.hint.json" : "settingsCore.mcp.connect.hint.terminal")}</span>
									<button type="button" className="linear-btn settings-copy-btn" onClick={() => void copy(tab, snippet)}>
										<CopyMark done={copied === tab} />
									</button>
								</div>
							</>
						) : (
							<>
								<div className="settings-list">
									{fields.map((field) => (
										<button
											key={field.key}
											type="button"
											className="settings-list-row settings-field"
											data-mcp-field={field.key}
											aria-label={`${t("settingsCore.mcp.connect.copy")}: ${field.label}`}
											onClick={() => void copy(field.key, field.value)}
										>
											<span className="settings-list-body">
												<span className="settings-list-title">{field.label}</span>
												<span className="settings-field-value">{field.value}</span>
											</span>
											<CopyMark done={copied === field.key} />
										</button>
									))}
								</div>
								<p className="settings-snippet-hint">{t("settingsCore.mcp.connect.hint.manual")}</p>
							</>
						)}
						{failed ? <div className="settings-error" role="alert">{t("settingsCore.mcp.connect.copyFailed")}</div> : null}
						<span className="sr-only" role="status" aria-live="polite">{copied === null ? "" : t("settingsCore.mcp.connect.copied")}</span>
					</div>
					<Row name={t("settingsCore.mcp.connect.readOnly")} hint={t("settingsCore.mcp.connect.readOnlyHint")}>
						<Switch checked={readOnly} ariaLabel={t("settingsCore.mcp.connect.readOnly")} onChange={() => setReadOnly((current) => !current)} />
					</Row>
				</>
			) : null}
		</Section>
	);
}
