import { describe, expect, it } from "vitest";
import type { CustomizerToolkit } from "../src/main/agents/profiles/customizer-kit";
import { aiCustomizerProfile } from "../src/main/agents/profiles/ai-customizer";
import { generalCustomizerProfile } from "../src/main/agents/profiles/general-customizer";
import { searchCustomizerProfile } from "../src/main/agents/profiles/search-customizer";
import { connectionsCustomizerProfile } from "../src/main/agents/profiles/connections-customizer";
import { appCustomizerProfile } from "../src/main/agents/profiles/app-customizer";
import { shortcutCustomizerProfile } from "../src/main/agents/profiles/shortcut-customizer";
import { magicActionProfile } from "../src/main/agents/profiles/magic-action";
import { errorFixProfile, type ErrorFixToolkit } from "../src/main/agents/profiles/error-fix";
import { createProposalCollector, smartIndexingProfile } from "../src/main/agents/profiles/smart-indexing";
import { createFolderSurvey } from "../src/main/agents/profiles/folder-stats";

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
const PROMPT_BUILDERS: readonly { readonly name: string; readonly prompt: (language: Language) => string }[] = [
	{ name: "ai-customizer (ai page)", prompt: (language) => aiCustomizerProfile({ language, surface: "ai", toolkit: emptyKit }).systemPrompt },
	{ name: "ai-customizer (web page)", prompt: (language) => aiCustomizerProfile({ language, surface: "web", toolkit: emptyKit }).systemPrompt },
	{
		name: "ai-customizer (with a shell)",
		prompt: (language) =>
			aiCustomizerProfile({
				language,
				surface: "ai",
				toolkit: { ...emptyKit, tools: [{ name: "bash" } as never] },
			}).systemPrompt,
	},
	{
		name: "general-customizer",
		prompt: (language) => generalCustomizerProfile({ language, surface: "general", toolkit: emptyKit }).systemPrompt,
	},
	{
		name: "search-customizer",
		prompt: (language) => searchCustomizerProfile({ language, surface: "indexing", toolkit: emptyKit }).systemPrompt,
	},
	{
		name: "connections-customizer",
		prompt: (language) => connectionsCustomizerProfile({ language, surface: "mcp", toolkit: emptyKit }).systemPrompt,
	},
	{
		name: "app-customizer",
		prompt: (language) => appCustomizerProfile({ language, toolkit: emptyKit }).systemPrompt,
	},
	{
		name: "shortcut-customizer",
		prompt: (language) => shortcutCustomizerProfile({ language, toolkit: emptyKit }).systemPrompt,
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
		name: "error-fix",
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
});
