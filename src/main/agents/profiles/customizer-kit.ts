import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AppCustomizerChange, AppCustomizerSurface } from "../../../shared/app-customizer-contract";
import type { SettingsBridge } from "../../../shared/settings-contract";
import type { RunPrompter } from "../customizer-prompter";
import type { ReplyLanguage } from "../profile-progress";

export type { ReplyLanguage };

/** The language name a system prompt asks the model to reply in. */
export const REPLY_LANGUAGE_NAME: Readonly<Record<ReplyLanguage, string>> = {
	ko: "Korean",
	en: "English",
	ja: "Japanese",
	zh: "Simplified Chinese",
};

/** One sentence in each interface language; the toolkit picks one when it records a change. */
export type Localized = Readonly<Record<ReplyLanguage, string>>;

/** What a Settings assistant profile hands the app customizer service: its tools and the changes they made this turn. */
export interface CustomizerToolkit {
	readonly tools: readonly ToolDefinition[];
	/** The changes made since the last call, which are then forgotten. */
	takeChanges(): readonly AppCustomizerChange[];
	peekChanges(): readonly AppCustomizerChange[];
}

/**
 * What a config assistant needs to deal with secrets without the model touching them (see `shared/secret-guard.ts`).
 * Absent in a window that cannot show a prompt (a remote browser session before it is wired): the secret tools then refuse.
 */
export interface CustomizerSecretDeps {
	/** The current run's way to ask the person in the panel; absent when no panel is attached. */
	readonly prompter?: () => RunPrompter | undefined;
	/** Every secret value this run has handled, so no later tool result or message can repeat one. */
	readonly known: Set<string>;
}

export interface CustomizerKitDeps {
	/** The interface language right now; Korean when omitted. */
	readonly language?: () => ReplyLanguage;
	/** True once the person stopped the run: a tool that has not written yet must then throw instead of writing. */
	readonly cancelled?: () => boolean;
}

export interface CustomizerKit {
	lang(): ReplyLanguage;
	/** Throws when the run was cancelled; call it before every write. */
	ensureLive(): void;
	/** Remembers a change for the turn's pills. `summary` is picked in the current interface language. */
	record(change: Omit<AppCustomizerChange, "summary"> & { readonly summary: Localized }): void;
	/** Wraps the tools with the change log the service reads. */
	toolkit(tools: readonly ToolDefinition[]): CustomizerToolkit;
}

export function createCustomizerKit(deps: CustomizerKitDeps): CustomizerKit {
	const lang = (): ReplyLanguage => deps.language?.() ?? "ko";
	const changes: AppCustomizerChange[] = [];
	return {
		lang,
		ensureLive: () => {
			if (deps.cancelled?.() === true) throw new Error("The customization request was cancelled.");
		},
		record: (change) => {
			const { summary, ...rest } = change;
			changes.push({ ...rest, summary: summary[lang()] });
		},
		toolkit: (tools) => ({
			tools,
			takeChanges: () => changes.splice(0),
			peekChanges: () => [...changes],
		}),
	};
}

export function textResult(value: unknown): {
	readonly content: [{ readonly type: "text"; readonly text: string }];
	readonly details: undefined;
} {
	const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
	return { content: [{ type: "text", text }], details: undefined };
}

/** What a Settings assistant that edits the shared AutoRAG config or the app preferences is built from. */
export interface ConfigCustomizerDeps extends CustomizerKitDeps {
	/** The same service the Settings pages write through, so every write is validated and persisted exactly as a click would. */
	readonly settings: SettingsBridge;
	readonly secrets?: CustomizerSecretDeps;
}

/** What `xProfile({...})` of a config assistant takes; `surface` picks the section's wording and focus in the prompt. */
export interface ConfigCustomizerProfileInput {
	readonly language: ReplyLanguage;
	readonly surface: AppCustomizerSurface;
	readonly toolkit: CustomizerToolkit;
}
