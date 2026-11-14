import { realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentProfile } from "@autorag/librarian/profiles";
import { describeMarks, type DocumentEditMode, type DocumentEditRequest } from "../../../preview/shared/annotation";
import { isSecretKey } from "../../autorag-config-service";
import { CREDENTIAL_NAME, inside, normalizeFencePath } from "../path-fence";
import { intentPromptLine, withIntentTools, type ReplyLanguage } from "../profile-progress";

const LANGUAGE_NAME: Readonly<Record<ReplyLanguage, string>> = {
	ko: "Korean",
	en: "English",
	ja: "Japanese",
	zh: "Simplified Chinese",
};

export interface DocumentEditProfileInput {
	readonly language: ReplyLanguage;
	/** The one file the person marked up in Quick Look; the only file the agent may change. */
	readonly path: string;
	readonly mode: DocumentEditMode;
	/** A private folder for unpacking a package document; the agent may write here too. */
	readonly scratchDir: string;
	readonly agentDir: string;
	readonly env: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
	readonly cancelled?: () => boolean;
}

/**
 * The tools of a `document-edit` session. Reading is open (the document may
 * refer to its neighbours) except for credentials and Dazzi's agent dir, whose
 * installed skills stay readable. Writing is fenced to the marked-up file and
 * the scratch folder. A package document also gets a shell, run in the scratch
 * folder, to unpack and repack the file.
 */
function documentEditTools(input: DocumentEditProfileInput): readonly ToolDefinition[] {
	const platform = input.platform ?? process.platform;
	const cancelled = input.cancelled ?? (() => false);
	const cwd = input.scratchDir;
	const agentDir = resolve(input.agentDir);
	const agentDirReal = realpath(agentDir).catch(() => agentDir);
	const skillsDir = join(agentDir, "skills");
	const skillsDirReal = realpath(skillsDir).catch(() => skillsDir);
	const target = resolve(input.path);
	const targetReal = realpath(target).catch(() => target);
	const scratch = resolve(input.scratchDir);
	const scratchReal = realpath(scratch).catch(() => scratch);

	async function locate(rawPath: string): Promise<{ readonly resolved: string; readonly real: string }> {
		const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath);
		return { resolved, real: await realpath(resolved).catch(() => resolved) };
	}

	async function guardRead(rawPath: string): Promise<void> {
		const { resolved, real } = await locate(rawPath);
		if (CREDENTIAL_NAME.test(basename(resolved)) || CREDENTIAL_NAME.test(basename(real))) {
			throw new Error("Refused: credential and private key files are off limits.");
		}
		if (inside(real, await agentDirReal, platform) || inside(resolved, agentDir, platform)) {
			if (inside(real, await skillsDirReal, platform) || inside(resolved, skillsDir, platform)) return;
			throw new Error("Refused: Dazzi's internal sign-in and credential directory is off limits.");
		}
	}

	async function guardWrite(rawPath: string): Promise<void> {
		await guardRead(rawPath);
		const { resolved, real } = await locate(rawPath);
		const same = (a: string, b: string): boolean => normalizeFencePath(a, platform) === normalizeFencePath(b, platform);
		if (same(real, await targetReal) || same(resolved, target)) return;
		if (inside(real, await scratchReal, platform) || inside(resolved, scratch, platform)) return;
		throw new Error(`Refused: only ${target} may be changed (scratch files go in ${scratch}).`);
	}

	// biome-ignore lint/suspicious/noExplicitAny: forwards a pi tool's execute after the fence check.
	function guarded<T extends ToolDefinition<any, any, any>>(tool: T, check: (params: Record<string, unknown>) => Promise<void>): T {
		const inner = tool.execute as (...args: unknown[]) => Promise<unknown>;
		return {
			...tool,
			execute: async (...args: unknown[]) => {
				if (cancelled()) throw new Error("The edit was cancelled.");
				await check((args[1] ?? {}) as Record<string, unknown>);
				return inner(...args);
			},
		} as unknown as T;
	}

	const pathOf = (params: Record<string, unknown>): string => (typeof params.path === "string" ? params.path : "");
	const readCheck = async (params: Record<string, unknown>): Promise<void> => {
		if (pathOf(params) !== "") await guardRead(pathOf(params));
	};
	const writeCheck = (params: Record<string, unknown>): Promise<void> => guardWrite(pathOf(params));

	const tools: ToolDefinition[] = [
		guarded(createReadToolDefinition(cwd), readCheck),
		guarded(createLsToolDefinition(cwd), readCheck),
		guarded(createFindToolDefinition(cwd), readCheck),
		guarded(createGrepToolDefinition(cwd), readCheck),
		guarded(createEditToolDefinition(cwd), writeCheck),
		guarded(createWriteToolDefinition(cwd), writeCheck),
	] as unknown as ToolDefinition[];

	if (input.mode === "package") {
		const bash = createBashToolDefinition(cwd, {
			spawnHook: (context) => ({ ...context, env: Object.fromEntries(Object.entries({ ...context.env, ...input.env }).filter(([key]) => !isSecretKey(key))) }),
		});
		tools.push(
			guarded(bash, async (params) => {
				const command = normalizeFencePath(typeof params.command === "string" ? params.command : "", platform);
				const agentPaths = [await agentDirReal, agentDir].map((path) => normalizeFencePath(path, platform));
				const skillPaths = [await skillsDirReal, skillsDir].map((path) => normalizeFencePath(path, platform));
				const withoutSkills = skillPaths.reduce((text, path) => text.split(path).join(""), command);
				if (/\b(?:auth|models|mcp|mcp-auth)\.json\b/u.test(command) || agentPaths.some((path) => withoutSkills.includes(path))) {
					throw new Error("Refused: Dazzi's internal sign-in and credential files are off limits.");
				}
			}) as unknown as ToolDefinition,
		);
	}
	return withIntentTools(tools, { language: input.language });
}

function systemPrompt(input: DocumentEditProfileInput): string {
	const ext = extname(input.path).slice(1).toLowerCase();
	const modeRules =
		input.mode === "text"
			? ["- The document is a text file. Read it, then change it with `edit` (small exact replacements); use `write` only when most of the file changes."]
			: [
					`- The document is a ${ext.toUpperCase()} package, not plain text. Work in the scratch folder ${input.scratchDir} with \`bash\`:`,
					"  copy the file there, unpack it (Office Open XML, HWPX and OpenDocument are ZIP archives of XML parts), edit the XML parts that hold the marked text,",
					"  repack it (keep every other entry byte-identical and in the same order; an HWPX/OpenDocument `mimetype` entry stays first and uncompressed),",
					`  and copy the result over ${input.path} only once the repacked archive lists cleanly (unzip -l).`,
					"- A binary .hwp file has no XML inside; use an installed skill or CLI that edits HWP if one is available, otherwise say you cannot edit it.",
					"- Prefer tools already on the machine (unzip/zip, python3). Do not install anything.",
				];
	return [
		"You are Dazzi's document editor. The person looked at one document in Dazzi's Quick Look preview, drew marks on it (pen strokes, boxes, underlines), and wrote what should change.",
		`Always write your final reply in ${LANGUAGE_NAME[input.language]}.`,
		"",
		"## Rules",
		`- The document is ${input.path}. It is the only file you may change; edit it in place. Never create, rename, move or delete other files outside the scratch folder ${input.scratchDir}.`,
		"- The marks show WHERE to change; the instruction says WHAT to change. Each mark lists its page and the text the preview showed under it; the attached image, when there is one, is the preview as the person saw it with the marks drawn on it.",
		"- Change only what the instruction asks for. Keep the rest of the document — wording, formatting, structure, encoding, line endings — exactly as it is.",
		"- Do not ask follow-up questions. If the instruction cannot be done safely, leave the file unchanged and say why.",
		...modeRules,
		"- End with a short summary of what you changed (or why nothing changed).",
		"",
		intentPromptLine(input.language),
	].join("\n");
}

export function documentEditProfile(input: DocumentEditProfileInput): AgentProfile {
	return {
		id: "document-edit",
		systemPrompt: systemPrompt(input),
		tools: [],
		customTools: documentEditTools(input),
		thinking: "low",
		context: { skills: input.mode === "package" },
	};
}

/** The user turn: the file, the instruction, and the marks page by page. */
export function documentEditMessage(request: DocumentEditRequest): string {
	return [
		`Document: ${request.path}`,
		"",
		"Instruction:",
		request.instruction.trim(),
		"",
		"Marks drawn on the preview (pages are numbered as the preview shows them):",
		describeMarks(request.marks),
	].join("\n");
}
