import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { normalizeContextMenuSettings, normalizeMagicAction, type MagicAction } from "../shared/context-menu-contract";
import type { SettingsBridge } from "../shared/settings-contract";
import {
	buildMagicActionCandidate,
	verifyMagicActionInSandbox,
	magicActionVerificationKey,
	type MagicActionVerificationResult,
	type SandboxFixtureInput,
	type VerifyMagicActionInput,
} from "./magic-action-sandbox";
import type { ReplyLanguage } from "./agents/profile-progress";
import {
	buildWorkflowVerificationGuidance,
	createVerificationTracker,
	verifyBeforeSave,
	formatVerificationFailureMessage,
	formatVerificationPassSummary,
} from "./workflow-sandbox";

/**
 * The three tools that create, verify, and remove right-click Magic Actions, shared by every agent
 * surface that can manage Magic Actions:
 * - the Settings → Sidebar/Context Menu customizer (`app-customizer`),
 * - Dazzi's main AI Agent (AI Search) chat.
 *
 * Both surfaces run the exact same save gate: a Magic Action may only be saved after it passed
 * verification in an isolated temporary sandbox folder (either an explicit `test_magic_action`
 * run for the same logic, or an automatic sandbox run inside `upsert_magic_action`).
 */
export interface MagicActionToolsDeps {
	/** The whole settings service: Magic Actions are stored in the app's `contextMenu` settings block. */
	readonly settings: Pick<SettingsBridge, "get" | "set">;
	/** Adds the read-only `list_magic_actions` tool (the main AI Agent exposes it; the settings customizer does not need it). */
	readonly includeListTool?: boolean;
	readonly platform?: NodeJS.Platform;
	readonly language?: () => ReplyLanguage;
	/** Optional cancellation check (throws when the enclosing run was aborted). */
	readonly cancelled?: () => boolean;
	/** Optional serializer sharing a settings-mutation queue with peer tools. */
	readonly serialize?: <T>(fn: () => Promise<T>) => Promise<T>;
	/** Runs a candidate Magic Action inside a temporary sandbox folder; when provided, `upsert_magic_action` enforces verification before saving. */
	readonly testMagicAction?: (input: VerifyMagicActionInput) => Promise<MagicActionVerificationResult>;
	/** Called after a Magic Action was saved, updated, or deleted, with a human-readable summary. */
	readonly onChange?: (change: { readonly kind: "saved" | "updated" | "deleted"; readonly label: string; readonly summary: string }) => void;
}

export interface MagicActionTools {
	readonly tools: readonly ToolDefinition[];
	/** Takes and clears the accumulated change records (the settings customizer surfaces them in its panel). */
	takeChanges(): readonly { readonly kind: "saved" | "updated" | "deleted"; readonly label: string; readonly summary: string }[];
	/** The accumulated change records without clearing them. */
	peekChanges(): readonly { readonly kind: "saved" | "updated" | "deleted"; readonly label: string; readonly summary: string }[];
}

function textResult(value: Record<string, unknown>): {
	readonly content: [{ readonly type: "text"; readonly text: string }];
	readonly details: Record<string, unknown>;
} {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
}

function summarizeChange(
	language: ReplyLanguage,
	kind: "saved" | "updated" | "deleted",
	label: string,
): string {
	// The settings customizer localizes its own summaries through its change summarizer; the tools only need a stable
	// English fallback that every caller can show or adapt.
	const action = kind === "saved" ? "added" : kind === "updated" ? "updated" : "removed";
	return `Magic Action ${label} was ${action} (interface language: ${language}).`;
}

function defaultSandboxRunner(
	deps: MagicActionToolsDeps,
	language: () => ReplyLanguage,
): (input: VerifyMagicActionInput) => Promise<MagicActionVerificationResult> {
	return deps.testMagicAction ?? ((verifyInput) => verifyMagicActionInSandbox(verifyInput, {
		resolveModel: () => Promise.reject(new Error("Agent Magic Action sandbox runner is not configured.")),
		agentDir: "",
		env: process.env,
		platform: deps.platform ?? process.platform,
		language,
	}));
}

export function createMagicActionTools(deps: MagicActionToolsDeps): MagicActionTools {
	const platform = deps.platform ?? process.platform;
	const language = (): ReplyLanguage => deps.language?.() ?? "ko";
	const isCancelled = (): boolean => deps.cancelled?.() === true;
	const ensureLive = (): void => {
		if (isCancelled()) throw new Error("Cancelled");
	};
	const serialized = deps.serialize ?? (<T>(fn: () => Promise<T>): Promise<T> => fn());
	const verifiedActions = createVerificationTracker<MagicAction, MagicActionVerificationResult>(magicActionVerificationKey);
	const changes: { readonly kind: "saved" | "updated" | "deleted"; readonly label: string; readonly summary: string }[] = [];
	const runner = defaultSandboxRunner(deps, language);

	const recordChange = (kind: "saved" | "updated" | "deleted", label: string): void => {
		const summary = summarizeChange(language(), kind, label);
		changes.push({ kind, label, summary });
		deps.onChange?.({ kind, label, summary });
	};

	const stringEnum = <const T extends readonly string[]>(values: T, description: string) =>
		Type.Unsafe<T[number]>({ type: "string", enum: [...values], description });

	const listMagicActions = defineTool({
		name: "list_magic_actions",
		label: "List Magic Actions",
		description:
			"List all custom right-click Magic Actions currently saved in Dazzi (id, label, enabled, selection/target/extension filters, and execution kind: script command or AI agent prompt). Read-only; use it to inspect existing Magic Actions before customizing, updating, or deleting them.",
		parameters: Type.Object({}),
		execute: async () => {
			const currentApp = await deps.settings.get();
			const current = normalizeContextMenuSettings(currentApp.contextMenu);
			return textResult({
				ok: true,
				magicActions: current.magicActions.map((action) => ({
					id: action.id,
					label: action.label,
					description: action.description ?? "",
					enabled: action.enabled,
					selection: action.selection,
					targetKind: action.targetKind,
					extensions: action.extensions,
					executionKind: action.execution.kind,
					...(action.execution.kind === "script" ? { command: action.execution.command } : {}),
					...(action.execution.kind === "agent"
						? {
								agentMode: action.execution.mode,
								prompt: action.execution.prompt,
								useSkills: action.execution.useSkills,
								useMcp: action.execution.useMcp,
							}
						: {}),
				})),
			});
		},
	});

	const testMagicAction = defineTool({
		name: "test_magic_action",
		label: "Test Magic Action in Sandbox",
		description:
			"Test a Magic Action (by saved `actionId` or an inline candidate definition) inside an isolated temporary sandbox folder with sample files. Runs the real shell command or AI agent loop against sample files in the temp folder, returns exit status, stdout/stderr or agent reply, and the exact created/modified/deleted file diff with content previews, then deletes the temp folder. Always run this to verify a Magic Action works as intended before finalizing it, and if it fails or does not achieve the goal, fix and re-test until it succeeds.",
		parameters: Type.Object({
			actionId: Type.Optional(
				Type.String({
					description: "ID of an already saved Magic Action to test. Omit when testing an inline candidate definition before saving.",
				}),
			),
			label: Type.Optional(Type.String({ description: "Candidate label (required when actionId is omitted)." })),
			description: Type.Optional(Type.String({ description: "Candidate description." })),
			enabled: Type.Optional(Type.Boolean({ description: "Candidate enabled (default true)." })),
			selection: Type.Optional(stringEnum(["any", "single", "multiple"], "Selection rule for inline candidate.")),
			targetKind: Type.Optional(stringEnum(["any", "file", "folder"], "Target kind for inline candidate.")),
			extensions: Type.Optional(Type.Array(Type.String(), { description: "Extension filter for inline candidate." })),
			executionKind: Type.Optional(stringEnum(["script", "agent"], "Execution kind for inline candidate.")),
			command: Type.Optional(Type.String({ description: "Shell/PowerShell script for inline script candidate." })),
			agentMode: Type.Optional(stringEnum(["read", "organize"], "Agent mode for inline agent candidate.")),
			prompt: Type.Optional(Type.String({ description: "Prompt instruction for inline agent candidate." })),
			useSkills: Type.Optional(Type.Boolean({ description: "Whether the inline agent candidate loads Skills (default true)." })),
			useMcp: Type.Optional(Type.Boolean({ description: "Whether the inline agent candidate connects MCP servers (default true)." })),
			fixtures: Type.Optional(
				Type.Array(
					Type.Object({
						path: Type.String({ description: "Relative path inside the temporary sandbox folder (e.g. 'meeting.md' or 'sub/note.txt')." }),
						content: Type.Optional(Type.String({ description: "UTF-8 text content for a sample file." })),
						kind: Type.Optional(stringEnum(["file", "folder"], "Fixture kind (default 'file').")),
					}),
					{
						description: "Sample files/folders to create in the temp sandbox before running the action. Defaults to realistic files matching the action's targetKind/selection/extensions.",
					},
				),
			),
			targets: Type.Optional(
				Type.Array(Type.String(), {
					description: "Relative paths inside the sandbox to pass as selected target(s). Defaults to the created fixture files/folders.",
				}),
			),
			timeoutMs: Type.Optional(
				Type.Integer({ minimum: 1000, maximum: 180_000, description: "Sandbox test timeout in milliseconds (default 60000)." }),
			),
		}),
		execute: async (_callId, params) => {
			ensureLive();
			let candidate: MagicAction | null = null;
			if (params.actionId !== undefined && params.actionId.trim().length > 0) {
				const currentApp = await deps.settings.get();
				const current = normalizeContextMenuSettings(currentApp.contextMenu);
				const needle = params.actionId.trim().toLowerCase();
				candidate =
					current.magicActions.find(
						(item) => item.id.toLowerCase() === needle || item.label.toLowerCase() === needle,
					) ?? null;
				if (candidate === null) {
					return textResult({
						ok: false,
						error: `No saved Magic Action found matching '${params.actionId}'.`,
					});
				}
			} else {
				if (params.executionKind === undefined || params.label === undefined) {
					return textResult({
						ok: false,
						error: "Provide either `actionId` or an inline candidate (`label`, `executionKind`, and `command` or `prompt`).",
					});
				}
				candidate = buildMagicActionCandidate({
					label: params.label,
					...(params.description !== undefined ? { description: params.description } : {}),
					...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
					...(params.selection !== undefined ? { selection: params.selection } : {}),
					...(params.targetKind !== undefined ? { targetKind: params.targetKind } : {}),
					...(params.extensions !== undefined ? { extensions: params.extensions } : {}),
					executionKind: params.executionKind,
					...(params.command !== undefined ? { command: params.command } : {}),
					...(params.agentMode !== undefined ? { agentMode: params.agentMode } : {}),
					...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
					...(params.useSkills !== undefined ? { useSkills: params.useSkills } : {}),
					...(params.useMcp !== undefined ? { useMcp: params.useMcp } : {}),
				});
				if (candidate === null) {
					return textResult({
						ok: false,
						error: "Invalid candidate Magic Action: ensure label and command (for script) or prompt (for agent) are non-empty.",
					});
				}
			}

			const result = await runner({
				action: candidate,
				...(params.fixtures !== undefined ? { fixtures: params.fixtures as readonly SandboxFixtureInput[] } : {}),
				...(params.targets !== undefined ? { targets: params.targets } : {}),
				...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
			});
			if (result.ok) verifiedActions.markVerified(candidate, result);
			else verifiedActions.clear(candidate);

			return textResult({
				...result,
				verificationGuidance: buildWorkflowVerificationGuidance({
					kind: "magic-action",
					ok: result.ok,
					testToolName: "test_magic_action",
					saveToolName: "upsert_magic_action",
				}),
				action: {
					id: candidate.id,
					label: candidate.label,
					executionKind: candidate.execution.kind,
				},
			});
		},
	});

	const upsertMagicAction = defineTool({
		name: "upsert_magic_action",
		label: "Upsert Magic Action",
		description:
			platform === "win32"
				? "Create or update a custom right-click Magic Action button on files/folders. On this Windows machine, `executionKind: 'script'` runs in `powershell.exe` receiving selected file paths in `$args` and `$env:DAZZI_FILES_JSON` (`$env:DAZZI_FILE`, `$env:DAZZI_FILE_COUNT`) — write valid PowerShell (never POSIX `\"$@\"` or `shasum`). Alternatively, `executionKind: 'agent'` (`agentMode: 'read' | 'organize'`) runs an AI agent loop with a custom `prompt` on the selected files. Supports filtering by `selection` ('any' | 'single' | 'multiple'), `targetKind` ('any' | 'file' | 'folder'), and `extensions` (e.g. ['pdf', 'png'])."
				: "Create or update a custom right-click Magic Action button on files/folders. A Magic Action can run ANY shell command/script (`executionKind: 'script'`) receiving selected files in `\"$@\"` and `DAZZI_FILES_JSON`, OR run an AI agent loop (`executionKind: 'agent'`, `agentMode: 'read' | 'organize'`) with a custom `prompt` on the selected files. Supports filtering by `selection` ('any' | 'single' | 'multiple'), `targetKind` ('any' | 'file' | 'folder'), and `extensions` (e.g. ['pdf', 'png']).",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Stable slug ID (optional on create; derived from label if omitted; pass existing id to update)." })),
			label: Type.String({ description: "Menu button label shown on right-click (e.g. 'PDF 3줄 요약', '이미지 용량 정리', 'SHA-256 해시 복사')." }),
			description: Type.Optional(Type.String({ description: "Short description shown in Settings." })),
			enabled: Type.Optional(Type.Boolean({ description: "Whether this Magic Action is enabled (default true)." })),
			selection: Type.Optional(
				stringEnum(["any", "single", "multiple"], "When to show: 'single' (1 item), 'multiple' (2+ items batch), or 'any' (1 or more items)."),
			),
			targetKind: Type.Optional(
				stringEnum(["any", "file", "folder"], "Target type filter: 'file', 'folder', or 'any'."),
			),
			extensions: Type.Optional(
				Type.Array(Type.String(), {
					description: "File extensions filter (e.g. ['pdf', 'docx'] or ['png', 'jpg']). Omit or pass [] to match all extensions.",
				}),
			),
			executionKind: stringEnum(["script", "agent"], "'script' runs a shell command/code; 'agent' runs a pi AI agent loop on the target files."),
			command: Type.Optional(
				Type.String({
					description:
						platform === "win32"
							? "Required when executionKind='script'. Windows PowerShell script/command to execute in powershell.exe. Selected file paths are passed in PowerShell's $args array (e.g. Get-FileHash -Algorithm SHA256 -LiteralPath $args) and in env vars $env:DAZZI_FILES_JSON (JSON string array), $env:DAZZI_FILE (first path), $env:DAZZI_FILE_COUNT. Do NOT use POSIX \"$@\" or $VAR syntax."
							: "Required when executionKind='script'. Shell command to execute in /bin/sh. Selected file paths are passed as positional arguments (\"$@\") and in env vars DAZZI_FILES_JSON (JSON string array), DAZZI_FILE (first path), DAZZI_FILE_COUNT.",
				}),
			),
			agentMode: Type.Optional(
				stringEnum(["read", "organize"], "Used when executionKind='agent': 'read' for read-only analysis/summary/Q&A; 'organize' when the agent may create, edit, convert, rename, move, or run tools on files."),
			),
			prompt: Type.Optional(
				Type.String({
					description: "Required when executionKind='agent'. Instruction telling the agent what to do with the selected file(s).",
				}),
			),
			useSkills: Type.Optional(
				Type.Boolean({
					description: "Used when executionKind='agent'. Share installed Skills with the AutoRAG Agent (default: true; set false to disable skills for this action).",
				}),
			),
			useMcp: Type.Optional(
				Type.Boolean({
					description: "Used when executionKind='agent'. Share connected MCP servers (such as Aside MCP in mcp.json) with the AutoRAG Agent (default: true; set false to disable MCP servers for this action).",
				}),
			),
		}),
		execute: (_callId, params) => serialized(async () => {
			ensureLive();
			const execution =
				params.executionKind === "script"
					? { kind: "script" as const, command: params.command ?? "" }
					: {
							kind: "agent" as const,
							mode: params.agentMode === "organize" ? ("organize" as const) : ("read" as const),
							prompt: params.prompt ?? "",
							useSkills: params.useSkills ?? true,
							useMcp: params.useMcp ?? true,
						};
			const normalized = normalizeMagicAction({
				id: params.id,
				label: params.label,
				description: params.description,
				enabled: params.enabled ?? true,
				selection: params.selection ?? "any",
				targetKind: params.targetKind ?? "file",
				extensions: params.extensions ?? [],
				execution,
			});
			if (normalized === null) {
				return textResult({
					ok: false,
					error: "Invalid Magic Action: ensure label is non-empty and command (for script) or prompt (for agent) is provided.",
				});
			}

			// Shared save gate: whenever a sandbox runner is wired, refuse to save until the exact Magic Action logic passed in a temp folder.
			let verification: MagicActionVerificationResult | undefined = verifiedActions.getVerified(normalized);
			let autoVerified = false;
			if (deps.testMagicAction !== undefined) {
				const gate = await verifyBeforeSave({
					candidate: normalized,
					tracker: verifiedActions,
					verify: (candidate) => runner({ action: candidate }),
				});
				if (!gate.ok) {
					return textResult({
						ok: false,
						saved: false,
						verified: false,
						error: formatVerificationFailureMessage({
							kind: "magic-action",
							label: normalized.label,
							result: gate.verification,
							testToolName: "test_magic_action",
						}),
						verification: gate.verification,
					});
				}
				verification = gate.verification;
				autoVerified = gate.autoVerified;
			}

			const currentApp = await deps.settings.get();
			const current = normalizeContextMenuSettings(currentApp.contextMenu);
			const existingIdx = current.magicActions.findIndex((item) => item.id === normalized.id);
			const nextActions = [...current.magicActions];
			if (existingIdx >= 0) nextActions[existingIdx] = normalized;
			else nextActions.push(normalized);

			const nextContextMenu = normalizeContextMenuSettings({
				...current,
				magicActions: nextActions,
			});
			ensureLive();
			await deps.settings.set({ contextMenu: nextContextMenu });
			const kind: "saved" | "updated" = existingIdx >= 0 ? "updated" : "saved";
			recordChange(kind, normalized.label);

			return textResult({
				ok: true,
				saved: true,
				...(verification !== undefined
					? {
							verified: true,
							autoVerified,
							verification,
							...(autoVerified
								? {
										verificationNote: formatVerificationPassSummary({
											result: verification,
											autoVerified: true,
											testToolName: "test_magic_action",
										}),
									}
								: {}),
						}
					: {}),
				magicAction: normalized,
				contextMenu: nextContextMenu,
			});
		}),
	});

	const deleteMagicAction = defineTool({
		name: "delete_magic_action",
		label: "Delete Magic Action",
		description: "Remove a custom right-click Magic Action by its ID or display label.",
		parameters: Type.Object({
			idOrLabel: Type.String({ description: "The ID or exact label of the Magic Action to delete." }),
		}),
		execute: (_callId, params) => serialized(async () => {
			ensureLive();
			const needle = params.idOrLabel.trim().toLowerCase();
			const currentApp = await deps.settings.get();
			const current = normalizeContextMenuSettings(currentApp.contextMenu);
			const target = current.magicActions.find(
				(action) => action.id.toLowerCase() === needle || action.label.toLowerCase() === needle,
			);
			if (target === undefined) {
				return textResult({
					ok: false,
					error: `No Magic Action found matching '${params.idOrLabel}'.`,
				});
			}
			const nextContextMenu = normalizeContextMenuSettings({
				...current,
				magicActions: current.magicActions.filter((action) => action.id !== target.id),
			});
			ensureLive();
			await deps.settings.set({ contextMenu: nextContextMenu });
			recordChange("deleted", target.label);
			return textResult({
				ok: true,
				deleted: target,
				contextMenu: nextContextMenu,
			});
		}),
	});

	const tools: ToolDefinition[] = [upsertMagicAction, testMagicAction, deleteMagicAction];
	if (deps.includeListTool === true) tools.push(listMagicActions);

	return {
		tools,
		takeChanges: () => changes.splice(0),
		peekChanges: () => [...changes],
	};
}
