import { describe, expect, it } from "vitest";
import type { CustomizerToolkit } from "../src/main/agents/profiles/customizer-kit";
import { connectionsCustomizerProfile } from "../src/main/agents/profiles/connections-customizer";
import { datasourceConnectionsProfile } from "../src/main/agents/profiles/datasource-connections-customizer";
import { settingsCustomizerProfile } from "../src/main/agents/profiles/settings-customizer";
import { magicActionProfile } from "../src/main/agents/profiles/magic-action";
import { documentEditProfile } from "../src/main/agents/profiles/document-edit";
import { errorFixProfile, type ErrorFixToolkit } from "../src/main/agents/profiles/error-fix";
import { createProposalCollector, smartIndexingProfile } from "../src/main/agents/profiles/smart-indexing";
import { createFolderSurvey } from "../src/main/agents/profiles/folder-stats";
import { buildUnifiedWorkflowsPrompt } from "../src/main/workflow-sandbox";

type Language = "ko" | "en" | "ja" | "zh";

/** The language name a prompt may use only as the fallback when the person has not written anything yet. */
const LANGUAGE_NAME: Readonly<Record<Language, string>> = {
	ko: "Korean",
	en: "English",
	ja: "Japanese",
	zh: "Simplified Chinese",
};

const LANGUAGES: readonly Language[] = ["ko", "en", "ja", "zh"];

/** Hangul (jamo, compatibility jamo, syllables), Hiragana/Katakana, and CJK ideographs (incl. extensions). */
const NOT_ENGLISH =
	/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/u;

const emptyKit: CustomizerToolkit = { tools: [], takeChanges: () => [], peekChanges: () => [] };
const emptyErrorFixKit: ErrorFixToolkit = {
	tools: [],
	result: () => null,
	trace: () => ({ changes: [], backupPath: null }),
};

/** Builds one profile's system prompt for a given interface language; the toolkit itself never reaches the prompt. */
const PROMPT_BUILDERS: readonly { readonly name: string; readonly prompt: (language: Language) => string; /** Nobody types to this helper, so the interface language decides. */ readonly interfaceLanguage?: true }[] = [
	{
		name: "connections-customizer",
		prompt: (language) => connectionsCustomizerProfile({ language, surface: "mcp", toolkit: emptyKit }).systemPrompt,
	},
	{
		name: "connections-customizer (with a shell)",
		prompt: (language) =>
			connectionsCustomizerProfile({
				language,
				surface: "mcp",
				toolkit: { ...emptyKit, tools: [{ name: "bash" } as never] },
			}).systemPrompt,
	},
	{
		name: "datasource-connections-customizer",
		prompt: (language) => datasourceConnectionsProfile({ language, surface: "apps", toolkit: emptyKit }).systemPrompt,
	},
	{
		name: "datasource-connections-customizer (with a shell)",
		prompt: (language) =>
			datasourceConnectionsProfile({
				language,
				surface: "apps",
				toolkit: { ...emptyKit, tools: [{ name: "bash" } as never] },
			}).systemPrompt,
	},
	{
		name: "settings-customizer (unified)",
		prompt: (language) => settingsCustomizerProfile({ language, surface: "ltr", toolkit: emptyKit }).systemPrompt,
	},
	{
		name: "settings-customizer (unified with a shell)",
		prompt: (language) =>
			settingsCustomizerProfile({
				language,
				surface: "all",
				toolkit: { ...emptyKit, tools: [{ name: "bash" } as never] },
			}).systemPrompt,
	},
	{
		name: "settings-customizer (win32)",
		prompt: (language) => settingsCustomizerProfile({ language, surface: "contextMenu", toolkit: emptyKit, platform: "win32" }).systemPrompt,
	},
	{
		name: "magic-action",
		prompt: (language) =>
			magicActionProfile({
				language,
				mode: "read",
				actionLabel: "Test action",
				prompt: "Summarize the file.",
				cwd: process.cwd(),
				agentDir: process.cwd(),
				env: {},
			}).systemPrompt,
	},
	{
		name: "document-edit",
		prompt: (language) =>
			documentEditProfile({
				language,
				path: "/tmp/plan.md",
				mode: "text",
				scratchDir: "/tmp/scratch",
				agentDir: process.cwd(),
				env: {},
			}).systemPrompt,
	},
	{
		name: "error-fix",
		interfaceLanguage: true,
		prompt: (language) => errorFixProfile({ message: "boom", surface: "ai-search", language, toolkit: emptyErrorFixKit }).systemPrompt,
	},
	{
		name: "smart-indexing",
		prompt: (language) => {
			const roots = [process.cwd()];
			const survey = createFolderSurvey(roots, { supportedExtensions: new Set([".md"]), maxSourceBytes: 1000 });
			return smartIndexingProfile({ roots, language, extensions: [".md"], collector: createProposalCollector(roots, survey), survey }).systemPrompt;
		},
	},
];

describe("every profile's system prompt is written in English and defers to the person's language", () => {
	for (const builder of PROMPT_BUILDERS) {
		for (const language of LANGUAGES) {
			it(`${builder.name} (interface language ${language})`, () => {
				const prompt = builder.prompt(language);

				// (a) no Hangul, Hiragana, Katakana or CJK ideograph anywhere in the prompt.
				expect(prompt, `non-English text in ${builder.name}`).not.toMatch(NOT_ENGLISH);

				if (builder.interfaceLanguage === true) {
					expect(prompt).toContain(`in ${LANGUAGE_NAME[language]}, the language the app is shown in`);
					return;
				}

				// (b) the reply-language rule sends the model to the language the person writes in.
				expect(prompt).toMatch(/language the person writes in/iu);
				expect(prompt).toMatch(/their latest message decides/iu);

				// (c) the interface language name appears only as the fallback.
				const name = LANGUAGE_NAME[language];
				const occurrences = [...prompt.matchAll(new RegExp(name, "gu"))];
				expect(occurrences.length, `${builder.name} never names the fallback language`).toBeGreaterThan(0);
				for (const occurrence of occurrences) {
					const before = prompt.slice(Math.max(0, (occurrence.index ?? 0) - 90), occurrence.index);
					expect(before, `${name} not used as a fallback in ${builder.name}`).toMatch(/(?:unclear|not written anything yet)/iu);
				}
			});
		}
	}

	it("unified main-agent workflows addendum is written in English on all platforms", () => {
		for (const platform of ["darwin", "linux", "win32"] as const) {
			const prompt = buildUnifiedWorkflowsPrompt(platform, { includeMagicActions: true });
			expect(prompt).not.toMatch(NOT_ENGLISH);
			expect(prompt).toContain("test_automation_in_sandbox");
			expect(prompt).toContain("test_magic_action");
		}
	});
});
