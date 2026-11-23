import { resolve } from "node:path";
import { homedir } from "node:os";
import { check, type Question, type Verdict } from "jev-use";
import { redactSecrets } from "../../shared/secret-guard";

/**
 * The write gate of a Settings assistant's shell.
 *
 * Reading is never gated: an assistant may look at any file, list any folder and run any lookup (that is how it finds another coding
 * agent's config). What it may not do is change anything except the files its own profile manages (`mcp.json` for the MCP assistant,
 * the shell profile for a new environment variable). The same Jev the AutoRAG agent's file-change gate asks decides which side of the
 * line a command is on; a few things no judgment can excuse (`sudo`, pipe-to-shell, `eval`, deleting or moving what is not managed)
 * are refused without asking. When Jev cannot answer, plain rules decide: plainly read-only runs, a write that lands only in a managed
 * file runs, everything else is refused with the reason.
 */

/** A Jev client's `judge`, narrowed to what the gate uses. */
export type WriteJudge = (state: string, questions: Question[]) => Promise<{ readonly verdicts: readonly Verdict[] }>;

export interface WriteGateDeps {
	readonly cwd: string;
	/** Absolute paths the profile may change. A folder covers what is under it. */
	readonly managedPaths: readonly string[];
	/** A new `export NAME=…` line in a shell profile counts as managed (the AI-model assistant's environment variables). */
	readonly allowEnvVars: boolean;
	/** Jev; undefined when no decision backend is configured. */
	readonly judge: WriteJudge | undefined;
	readonly homeDir?: string;
}

export interface WriteGateResult {
	readonly allowed: boolean;
	/** Why not, in words the assistant can pass on. */
	readonly reason?: string;
}

export interface WriteGate {
	check(call: { readonly command: string }): Promise<WriteGateResult>;
}

/** Jev must put a write outside the managed files at or above this to refuse; below, and sure enough, it runs. */
const WRITE_PROBABILITY_LIMIT = 0.2;
const MIN_CONFIDENCE = 0.8;
const JEV_TIMEOUT_MS = 15_000;
const QUESTION_ID = "writes_outside_managed";

const SHELL_PROFILES = /(?:^|\/)(?:\.zshrc|\.zprofile|\.zshenv|\.bashrc|\.bash_profile|\.profile|config\.fish)$/u;
const EXPORT_LINE = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=\S/u;

/** Verbs that only ever read (as the first word of a segment). A segment starting with one of these and with no redirect writes nothing. */
const READ_VERBS: Readonly<Record<string, true>> = Object.fromEntries(
	[
		"cat", "head", "tail", "less", "more", "ls", "ll", "la", "which", "whereis", "type", "command", "grep", "egrep", "fgrep", "rg", "fd", "find", "jq", "yq",
		"echo", "printf", "pwd", "env", "printenv", "uname", "sw_vers", "whoami", "id", "hostname", "stat", "file", "wc", "sort", "uniq", "cut", "tr", "awk", "diff",
		"cmp", "du", "df", "ps", "date", "test", "[", "true", "false", "basename", "dirname", "realpath", "readlink", "strings", "xxd", "od", "tree", "sha256sum", "shasum", "md5", "sed",
	].map((verb) => [verb, true] as const),
);
/** Interpreters can do anything a script says, so a segment starting with one is never "plainly read-only": Jev judges it. */
const INTERPRETERS: Readonly<Record<string, true>> = { python3: true, python: true, node: true, ruby: true, perl: true };
/** `<tool> --version`, `<tool> -v`, `<tool> version`, `<tool> --help`: a probe, whatever the tool is. */
const PROBE = /^[\w./@+-]+\s+(?:--version|-v|-V|version|--help|-h|help)\s*$/u;
/** Subcommands of package managers that only list. */
const LISTING = /^(?:npm\s+(?:ls|list|view|info|root|prefix|config\s+get)|pnpm\s+(?:ls|list)|yarn\s+(?:list|info)|bun\s+pm\s+ls|brew\s+(?:list|info|--prefix|--version|search|outdated)|pipx\s+list|pip3?\s+(?:list|show|freeze)|gem\s+list|cargo\s+--list|git\s+(?:status|log|diff|show|branch|remote|config\s+--get|rev-parse|ls-files))\b/u;

const ALWAYS_REFUSED: ReadonlyArray<{ readonly pattern: RegExp; readonly why: string }> = [
	{ pattern: /(?:^|[\s;&|(])sudo\b|(?:^|[\s;&|(])doas\b|(?:^|[\s;&|(])su\s+-/u, why: "it asks for administrator rights" },
	{ pattern: /\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish|dash|python3?|node|ruby|perl)\b/u, why: "it pipes downloaded or generated text straight into a shell or interpreter" },
	{ pattern: /(?:^|[\s;&|(])eval\b|\bsource\s+<\(|\bbash\s+<\(|\bsh\s+<\(/u, why: "it evaluates text built at run time, so what it does cannot be told" },
];

/** Verbs that delete, move or reshape existing files: allowed only when every path they name is a managed one. */
const DESTRUCTIVE = /(?:^|[\s;&|(])(?:rm|rmdir|unlink|shred|mv|dd|truncate|chmod|chown|chgrp|ln|install|rsync|trash)\b/u;

function segments(command: string): string[] {
	return command
		.split(/\n|;|&&|\|\||\|/u)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

/** Every file a redirect in the command writes to, and whether the command has a write the gate cannot trace to a path. */
function redirectTargets(command: string): { readonly targets: readonly string[]; readonly untraced: boolean } {
	const targets: string[] = [];
	let untraced = false;
	for (const match of command.matchAll(/(?<![<\d&])(?:\d?|&)>{1,2}\s*(?:"([^"]+)"|'([^']+)'|(\S+))/gu)) {
		const target = (match[1] ?? match[2] ?? match[3] ?? "").trim();
		if (target.length === 0 || target === "/dev/null" || target === "&1" || target === "&2") continue;
		if (/[$`]/u.test(target)) untraced = true;
		else targets.push(target);
	}
	for (const match of command.matchAll(/\btee\b\s+(?:-a\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))/gu)) {
		const target = (match[1] ?? match[2] ?? match[3] ?? "").trim();
		if (target.length > 0 && !target.startsWith("-")) targets.push(target);
	}
	return { targets, untraced };
}

function wordsOf(segment: string): string[] {
	return [...segment.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

export function createWriteGate(deps: WriteGateDeps): WriteGate {
	const home = deps.homeDir ?? homedir();
	const expand = (raw: string): string => resolve(deps.cwd, raw === "~" || raw.startsWith("~/") ? raw.replace("~", home) : raw);
	const managed = deps.managedPaths.map((path) => resolve(path));
	const isManaged = (raw: string): boolean => {
		const path = expand(raw);
		return managed.some((root) => path === root || path.startsWith(`${root}/`));
	};

	/** True when nothing in the command writes, deletes or runs something that might. */
	function plainlyReadOnly(command: string): boolean {
		if (/[`]|\$\(/u.test(command)) return false;
		const { targets, untraced } = redirectTargets(command);
		if (targets.length > 0 || untraced) return false;
		if (/\bfind\b[^|;&]*(?:-delete|-exec|-execdir|-fprint|-fls|-ok)\b/u.test(command)) return false;
		if (/\bsed\b[^|;&]*\s-[a-zA-Z]*i/u.test(command)) return false;
		if (/\bawk\b[^|;&]*(?:system\s*\(|>\s*")/u.test(command)) return false;
		return segments(command).every((segment) => {
			const [head, second] = wordsOf(segment);
			if (head === undefined) return true;
			if (PROBE.test(segment) || LISTING.test(segment)) return true;
			if (INTERPRETERS[head] === true) return false;
			if (head === "command" && second === "-v") return true;
			return READ_VERBS[head] === true;
		});
	}

	/** True when every write the command makes lands in a managed file, by plain reading. */
	function onlyManagedWrites(command: string): boolean {
		if (/[`]|\$\(/u.test(command)) return false;
		const { targets, untraced } = redirectTargets(command);
		if (untraced) return false;
		for (const segment of segments(command)) {
			if (!DESTRUCTIVE.test(` ${segment}`)) continue;
			const paths = wordsOf(segment).slice(1).filter((word) => !word.startsWith("-"));
			if (paths.length === 0 || !paths.every(isManaged)) return false;
		}
		if (targets.length === 0) return plainlyReadOnly(command);
		return targets.every((target) => isManaged(target) || (deps.allowEnvVars && isEnvProfileAppend(command, target)));
	}

	function isEnvProfileAppend(command: string, target: string): boolean {
		if (!SHELL_PROFILES.test(expand(target))) return false;
		if (!/>>/u.test(command)) return false;
		const line = /\becho\s+(?:-e\s+)?(?:"([^"]*)"|'([^']*)')/u.exec(command) ?? /\bprintf\s+(?:"([^"]*)"|'([^']*)')/u.exec(command);
		const text = line?.[1] ?? line?.[2];
		return text !== undefined && text.split(/\\n|\n/u).every((part) => part.trim().length === 0 || EXPORT_LINE.test(part));
	}

	function question(): Question {
		const files = managed.length === 0 ? "(none)" : managed.join(", ");
		const envNote = deps.allowEnvVars
			? " Appending a line that sets a NEW environment variable (`export NAME=value`) to a shell profile (~/.zshrc, ~/.zprofile, ~/.bashrc, ~/.profile, ~/.config/fish/config.fish) does NOT count: that is allowed. Rewriting or removing any other line of such a file does count."
			: "";
		return {
			...check(
				`Assume the proposed shell command runs. Does it create, change, overwrite, move, rename or delete any file or folder other than these managed files: ${files}? Reading, listing, searching and printing change nothing and do not count. Writing to /dev/null does not count. Installing software or running a program that changes files elsewhere does count.${envNote}`,
				{
					true: "It changes at least one file or folder outside the managed files.",
					false: "It changes nothing, or only the managed files.",
				},
			),
			id: QUESTION_ID,
		} as Question;
	}

	function stateFor(command: string): string {
		return [
			"You are judging one shell command that an AI assistant in a desktop app is about to run on the user's computer. The assistant may read anything. It may change only the managed files named in the question.",
			`Working directory: ${deps.cwd}`,
			`Managed files: ${managed.join(", ") || "(none)"}`,
			`Proposed command:\n${redactSecrets(command)}`,
		].join("\n\n");
	}

	return {
		async check({ command }) {
			if (command.trim().length === 0) return { allowed: false, reason: "The command is empty." };
			for (const { pattern, why } of ALWAYS_REFUSED) {
				if (pattern.test(command)) return { allowed: false, reason: `Refused: ${why}.` };
			}
			if (plainlyReadOnly(command)) return { allowed: true };
			// Deleting or moving what is not managed is refused whatever Jev says about it.
			for (const segment of segments(command)) {
				if (!DESTRUCTIVE.test(` ${segment}`)) continue;
				const paths = wordsOf(segment).slice(1).filter((word) => !word.startsWith("-"));
				if (paths.length === 0 || !paths.every(isManaged)) {
					return { allowed: false, reason: "Refused: it deletes, moves or reshapes files that this assistant does not manage. Reading is free; only the managed files may change." };
				}
			}
			const plain = onlyManagedWrites(command);
			if (deps.judge === undefined) {
				return plain
					? { allowed: true }
					: { allowed: false, reason: "Jev is unavailable, so a command that is not plainly read-only or limited to the managed files is not run. Sign in or connect a decision model, or ask for a read-only command." };
			}
			try {
				const timeout = AbortSignal.timeout(JEV_TIMEOUT_MS);
				const judgment = await Promise.race([
					deps.judge(stateFor(command), [question()]),
					new Promise<never>((_resolve, reject) => timeout.addEventListener("abort", () => reject(new Error("Jev did not answer in time")))),
				]);
				const verdict = judgment.verdicts.find((candidate) => candidate.id === QUESTION_ID);
				if (verdict === undefined || typeof verdict.answer !== "number" || verdict.escalate) throw new Error("Jev was not sure");
				if (verdict.confidence < MIN_CONFIDENCE) throw new Error(`Jev was only ${Math.round(verdict.confidence * 100)}% sure`);
				return verdict.answer >= WRITE_PROBABILITY_LIMIT
					? { allowed: false, reason: "Refused: Jev judged that it changes files other than the ones this assistant manages. Reading is free; only the managed files may change." }
					: { allowed: true };
			} catch (error) {
				return plain
					? { allowed: true }
					: { allowed: false, reason: `Jev could not judge this command (${error instanceof Error ? error.message : "no answer"}), so it was not run. Only plainly read-only commands and writes to the managed files run without it.` };
			}
		},
	};
}
