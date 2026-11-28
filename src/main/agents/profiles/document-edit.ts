import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
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
import type { PdfEditorIo } from "../../pdf-editor-io";
import type { PdfAssetRequest, PdfAssetResult } from "../../../shared/document-editor-contract";
import { createPdfAgentTools } from "../pdf-edit-tools";
import { CREDENTIAL_NAME, inside, normalizeFencePath } from "../path-fence";
import { createWriteGate, type WriteGate, type WriteJudge } from "../write-gate";
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
	readonly homeDir?: string;
	readonly writeJudge?: WriteJudge;
	/** Shared PDF editor engine used when `mode === "pdf"` so human and AI edits serialize safely. */
	readonly pdfIo?: PdfEditorIo;
	/** Whether the active model accepts image inputs (enables visual page PNG blocks in `pdf_render_page`). */
	readonly supportsImage?: boolean;
	/** Renders text boxes / notes / stamps / watermarks / images and finds text through the open editor. */
	readonly renderAsset?: (request: PdfAssetRequest) => Promise<PdfAssetResult>;
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

	const tools: ToolDefinition[] =
		input.mode === "pdf"
			? ([
					guarded(createReadToolDefinition(cwd), readCheck),
					guarded(createLsToolDefinition(cwd), readCheck),
					guarded(createFindToolDefinition(cwd), readCheck),
					guarded(createGrepToolDefinition(cwd), readCheck),
					...(input.pdfIo !== undefined
						? createPdfAgentTools({
								targetPath: target,
								pdfIo: input.pdfIo,
								cancelled,
								...(input.supportsImage === undefined ? {} : { supportsImage: input.supportsImage }),
								...(input.renderAsset === undefined ? {} : { renderAsset: input.renderAsset }),
								guardRead,
							})
						: []),
				] as unknown as ToolDefinition[])
			: ([
					guarded(createReadToolDefinition(cwd), readCheck),
					guarded(createLsToolDefinition(cwd), readCheck),
					guarded(createFindToolDefinition(cwd), readCheck),
					guarded(createGrepToolDefinition(cwd), readCheck),
					guarded(createEditToolDefinition(cwd), writeCheck),
					guarded(createWriteToolDefinition(cwd), writeCheck),
				] as unknown as ToolDefinition[]);

	if (input.mode === "package" || input.mode === "pdf") {
		const bash = createBashToolDefinition(cwd, {
			spawnHook: (context) => ({ ...context, env: Object.fromEntries(Object.entries({ ...context.env, ...input.env }).filter(([key]) => !isSecretKey(key))) }),
		});
		let gatePromise: Promise<WriteGate> | undefined;
		const getGate = () => {
			gatePromise ??= Promise.all([targetReal, scratchReal]).then(([resolvedTarget, resolvedScratch]) =>
				createWriteGate({
					cwd,
					homeDir: input.homeDir ?? homedir(),
					managedPaths: [...new Set([target, resolvedTarget, scratch, resolvedScratch])],
					allowEnvVars: false,
					judge: input.writeJudge,
				}),
			);
			return gatePromise;
		};
		tools.push(
			guarded(bash, async (params) => {
				const rawCommand = typeof params.command === "string" ? params.command : "";
				const command = normalizeFencePath(rawCommand, platform);
				const agentPaths = [await agentDirReal, agentDir].map((path) => normalizeFencePath(path, platform));
				const skillPaths = [await skillsDirReal, skillsDir].map((path) => normalizeFencePath(path, platform));
				const withoutSkills = skillPaths.reduce((text, path) => text.split(path).join(""), command);
				if (/\b(?:auth|models|mcp|mcp-auth)\.json\b/u.test(command) || agentPaths.some((path) => withoutSkills.includes(path))) {
					throw new Error("Refused: Dazzi's internal sign-in and credential files are off limits.");
				}
				const verdict = await (await getGate()).check({ command: rawCommand });
				if (!verdict.allowed) {
					throw new Error(verdict.reason ?? `Refused: only ${target} may be changed.`);
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
			: input.mode === "pdf"
				? [
						"- The document is a PDF file opened in Dazzi's live PDF editor. The person may keep editing pages in the toolbar while you work.",
						"- ALWAYS prefer the structured PDF tools (`pdf_inspect`, `pdf_render_page`, `pdf_apply_ops`, `pdf_fill_form`, `pdf_set_metadata`, `pdf_add_page_numbers`, `pdf_extract_pages`, `pdf_split`) over shell scripts! They run through Dazzi's shared per-file lock so your edits and the user's concurrent UI edits never overwrite each other, and the editor live-reloads after each call.",
						"- Start with `pdf_inspect` when you need page counts, dimensions, rotations, metadata, or AcroForm field names.",
						"- Visual page reading (`pdf_render_page`): You can render any 1-based page(s) of the PDF directly as PNG images into your context. Before making layout-sensitive edits (placing text, stamps, images, highlights, redactions, whiteouts, shapes, watermarks, page numbers, crops, or filling forms on pages you have not seen), call `pdf_render_page` on the target page(s) to inspect existing layout, margins, whitespace, and exact normalized coordinates.",
						"- Mandatory Visual QA after editing: After applying ANY visual or layout edit (`pdf_apply_ops`, `pdf_fill_form`, `pdf_add_page_numbers`, or bash-based PDF changes), ALWAYS call `pdf_render_page` on the modified page(s) to visually inspect the rendered result in image context. Verify there is no unintended overlap with existing text, no clipping at page edges, proper orientation/rotation, readable contrast and size, complete redaction/whiteout coverage, and intact characters (especially Korean/CJK). If you spot any visual defect, adjust coordinates/size/styling and re-verify with `pdf_render_page` before finishing, and briefly report what you visually verified.",
						"- In `pdf_apply_ops`, pageIndex is 0-based (page 1 -> 0) and coordinates are normalized 0..1 fractions from the top-left of the visible page.",
						"- Everything the person can do from the toolbar has a tool: `pdf_add_text_box` (text boxes, Korean OK), `pdf_add_note` (sticky-note memo cards), `pdf_add_stamp` (approved/confidential/draft/reviewed/urgent or custom stamps), `pdf_insert_image` (local image files incl. TIFF/HEIC, transparency kept), `pdf_add_watermark` (Korean OK), plus `pdf_apply_ops` for highlights, redaction/whiteout, shapes, freehand, crop and page operations. Use these instead of rendering PNGs yourself.",
						"- To mark, circle, underline, highlight, redact, or point at existing text, first call `pdf_find_text` to get its exact boxes and derive coordinates from them; never guess positions of existing text. To circle text use the hit's `ellipse` as the drawShape bounds (it clears the text's corners); for an arrow put the tip just outside the box and the tail in nearby empty space; put notes and stamps in margins or blank areas, not over content.",
						"- Use the attached screenshot, rendered page images from `pdf_render_page`, and mark bounds to place highlights, redactions, whiteouts, shapes, or text accurately.",
						"- Only fall back to `bash` (in the scratch folder) for work no structured PDF tool covers. Never overwrite the target PDF directly via bash when a PDF tool can apply the change.",
					]
				: [
						`- The document is a ${ext.toUpperCase()} package, not plain text. Work in the scratch folder ${input.scratchDir} with \`bash\`:`,
						"  copy the file there, unpack it (Office Open XML, HWPX and OpenDocument are ZIP archives of XML parts), edit the XML parts that hold the marked text,",
						"  repack it (keep every other entry byte-identical and in the same order; an HWPX/OpenDocument `mimetype` entry stays first and uncompressed),",
						`  and copy the result over ${input.path} only once the repacked archive lists cleanly (unzip -l).`,
						"- A binary .hwp file has no XML inside; use an installed skill or CLI that edits HWP if one is available, otherwise say you cannot edit it.",
						"- Prefer tools already on the machine (unzip/zip, python3). Do not install anything.",
					];
	return [
		"You are Dazzi's document editor. The person opened one document in Dazzi's editor, optionally drew marks on it (pen strokes, boxes, underlines) or selected text, and wrote what should change.",
		`Reply in the language the person writes in (their latest message decides); if it is unclear, reply in ${LANGUAGE_NAME[input.language]}.`,
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
		context: { skills: input.mode === "package" || input.mode === "pdf" },
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
