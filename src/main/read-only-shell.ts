/**
 * Whether a shell command can be PROVEN to only read. The librarian's file-change gate has the judgement model
 * (Jev) classify every `bash` call; with no judgement model available (a BYOK sign-in without OpenRouter) every
 * call, `ls` and `cat` included, would go to the person. This is the deterministic stand-in for the part that needs
 * no model: a command made only of read-only programs, with no write redirection, no command substitution and no
 * way to start another program.
 *
 * It is an allow-list. Anything it does not recognise (an unknown program, an option it cannot place, syntax it
 * does not parse, a command cut short for the model) is "not proven", and the gate asks the person as before. It
 * never says a command changes files; it only declines to vouch for one.
 */

export type ShellVerdict = { readonly readOnly: true } | { readonly readOnly: false; readonly why: string };

class NotProven extends Error {}

interface Word {
	readonly text: string;
	/** An unquoted or double-quoted `$` was in it: the shell may expand it into something else. */
	readonly dollar: boolean;
	/** Any part of it was quoted or escaped. */
	readonly quoted: boolean;
}

type RedirectKind = "read" | "write" | "dup-out" | "dup-in";

/** A command the model-facing text shortened: what is missing could hold a redirect. */
const SHORTENED = /\[\.\.\.\d+ characters omitted\.\.\.\]|\[unbroken text of \d+ characters omitted\]/u;

/** A static membership table; no prototype, so a program named `constructor` is not found in it. */
const table = (...names: readonly string[]): Readonly<Record<string, true>> =>
	Object.assign(Object.create(null), Object.fromEntries(names.map((name) => [name, true])));

const KEYWORDS_BEFORE_COMMAND = table("do", "then", "else", "elif", "if", "while", "until");
const SYSTEM_BIN_DIRS = ["/usr/bin/", "/bin/", "/usr/local/bin/", "/mingw64/bin/", "/opt/homebrew/bin/"];

/** Programs that cannot write a file or start another program whatever their arguments. */
const ALWAYS_READ_ONLY = table(
	"ls", "dir", "vdir", "cat", "tac", "nl", "head", "tail", "wc", "pwd", "cd", "echo", "printf", "true", "false", "test", "[",
	"basename", "dirname", "realpath", "readlink", "which", "type", "whoami", "hostname", "uname", "du", "df", "stat",
	"rev", "cut", "tr", "fold", "expand", "unexpand", "paste", "comm", "join", "diff", "cmp", "strings", "od", "hexdump",
	"md5sum", "sha1sum", "sha256sum", "sha512sum", "shasum", "cksum", "column", "seq", "sleep", "jq",
	"grep", "egrep", "fgrep", "zipinfo",
);

const SAFE_GIT_SUBCOMMANDS = table("status", "log", "diff", "show", "ls-files", "rev-parse", "blame", "ls-tree", "shortlog", "describe");
const FIND_WRITES_OR_RUNS = table("-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls");
const SED_SAFE_SHORT = table("n", "E", "r", "s", "u", "z");
const SED_SAFE_LONG = table("--quiet", "--silent", "--regexp-extended", "--separate", "--null-data", "--unbuffered", "--posix");
const SED_PLAIN_COMMANDS = table("p", "d", "D", "P", "N", "n", "g", "G", "h", "H", "x", "=");
const SED_S_FLAGS = table(..."gpiImM0123456789");
const SORT_SAFE_SHORT = table(..."bdfghiMnrRsuVz");

/** Single-dash option clusters (`-tvf`), without their dash, in the order given. */
function shortClusters(args: readonly string[]): string[] {
	return args.filter((arg) => arg.length > 1 && arg.startsWith("-") && !arg.startsWith("--")).map((arg) => arg.slice(1));
}

/**
 * Splits `command` into simple commands (`;`, `&&`, `||`, `|` and newlines separate them) of words, dropping the
 * redirections it can prove harmless (`< file`, `> /dev/null`, `2>&1`). Anything else a shell would do on its own
 * (substitution, subshells, here-documents, comments, background jobs, a write redirect) throws {@link NotProven}.
 */
function tokenize(source: string): Word[][] {
	const segments: Word[][] = [];
	let words: Word[] = [];
	let text = "";
	let started = false;
	let dollar = false;
	let quoted = false;
	let pending: RedirectKind | null = null;

	const endWord = (): void => {
		if (!started) return;
		const word: Word = { text, dollar, quoted };
		text = "";
		started = false;
		dollar = false;
		quoted = false;
		if (pending !== null) {
			const kind = pending;
			pending = null;
			const allowed =
				kind === "read" ||
				(kind === "write" && word.text === "/dev/null") ||
				(kind === "dup-out" && /^(?:\d+|-|\/dev\/null)$/u.test(word.text)) ||
				(kind === "dup-in" && /^(?:\d+|-)$/u.test(word.text));
			if (!allowed) throw new NotProven(`a redirect to ${word.text}`);
			return;
		}
		if (!word.quoted && (word.text === "{" || word.text === "}" || word.text === "!")) throw new NotProven(`the shell word ${word.text}`);
		words.push(word);
	};
	const endSegment = (): void => {
		endWord();
		if (pending !== null) throw new NotProven("a redirect without a target");
		segments.push(words);
		words = [];
	};
	const redirect = (kind: RedirectKind): void => {
		// `2>file`: the digits are the file descriptor, not an argument.
		if (started && !quoted && /^\d+$/u.test(text)) {
			text = "";
			started = false;
			dollar = false;
		} else endWord();
		pending = kind;
	};

	for (let i = 0; i < source.length; i++) {
		const ch = source.charAt(i);
		const next = source.charAt(i + 1);
		if (ch === " " || ch === "\t" || ch === "\r") endWord();
		else if (ch === "\n") endSegment();
		else if (ch === "\\") {
			if (next === "") throw new NotProven("a trailing backslash");
			if (next === "\n") i += 1;
			else if (next === "\r" && source.charAt(i + 2) === "\n") i += 2;
			else {
				text += next;
				started = true;
				quoted = true;
				i += 1;
			}
		} else if (ch === "'") {
			const close = source.indexOf("'", i + 1);
			if (close < 0) throw new NotProven("an unterminated quote");
			text += source.slice(i + 1, close);
			started = true;
			quoted = true;
			i = close;
		} else if (ch === '"') {
			started = true;
			quoted = true;
			let j = i + 1;
			for (; j < source.length && source.charAt(j) !== '"'; j++) {
				const inner = source.charAt(j);
				if (inner === "`" || (inner === "$" && (source.charAt(j + 1) === "(" || source.charAt(j + 1) === "'" || source.charAt(j + 1) === '"'))) {
					throw new NotProven("a command substitution");
				}
				if (inner === "$") dollar = true;
				if (inner === "\\" && "$`\"\\\n".includes(source.charAt(j + 1))) {
					j += 1;
					if (source.charAt(j) !== "\n") text += source.charAt(j);
				} else text += inner;
			}
			if (j >= source.length) throw new NotProven("an unterminated quote");
			i = j;
		} else if (ch === "`") throw new NotProven("a command substitution");
		else if (ch === "$") {
			if (next === "(" || next === "'" || next === '"') throw new NotProven("a command substitution");
			text += ch;
			started = true;
			dollar = true;
		} else if (ch === "(" || ch === ")") throw new NotProven("a subshell");
		else if (ch === "#" && !started) throw new NotProven("a comment");
		else if (ch === ";") {
			if (next === ";") throw new NotProven("a case clause");
			endSegment();
		} else if (ch === "|") {
			if (next === "|") i += 1;
			else if (next === "&") throw new NotProven("a pipe of both streams");
			endSegment();
		} else if (ch === "&") {
			if (next === "&") {
				i += 1;
				endSegment();
			} else if (next === ">") {
				redirect("write");
				i += source.charAt(i + 2) === ">" ? 2 : 1;
			} else throw new NotProven("a background job");
		} else if (ch === ">") {
			if (next === "(") throw new NotProven("a process substitution");
			if (next === "&") {
				redirect("dup-out");
				i += 1;
			} else if (next === ">" || next === "|") {
				redirect("write");
				i += 1;
			} else redirect("write");
		} else if (ch === "<") {
			if (next === "(" || next === "<" || next === ">") throw new NotProven("a here-document or process substitution");
			if (next === "&") {
				redirect("dup-in");
				i += 1;
			} else redirect("read");
		} else {
			text += ch;
			started = true;
		}
	}
	endSegment();
	return segments;
}

/**
 * Reads a sed pattern or replacement up to the unescaped `delimiter`. Returns the index after it. A delimiter
 * inside a bracket expression is read differently by GNU and BSD sed, so a script that has one is not proven.
 */
function sedSection(script: string, from: number, delimiter: string): number {
	let inBracket = false;
	for (let i = from; i < script.length; i++) {
		const ch = script.charAt(i);
		if (ch === "\\") i += 1;
		else if (ch === delimiter) {
			if (inBracket) throw new NotProven("a sed script with its delimiter inside brackets");
			return i + 1;
		} else if (ch === "[" && !inBracket) {
			inBracket = true;
			if (script.charAt(i + 1) === "^") i += 1;
			if (script.charAt(i + 1) === "]") i += 1;
		} else if (ch === "]" && inBracket) inBracket = false;
	}
	throw new NotProven("an unterminated sed command");
}

/** Accepts `s`, `y`, line printing and deleting; refuses anything that can write a file or run a command (`w`, `e`, `r`, `a`...). */
function checkSedScript(script: string): void {
	let i = 0;
	const skipSeparators = (): void => {
		while (i < script.length && " \t\n;".includes(script.charAt(i))) i += 1;
	};
	const skipAddress = (): void => {
		const ch = script.charAt(i);
		if (ch === "/") {
			i = sedSection(script, i + 1, "/");
			while (script.charAt(i) === "I" || script.charAt(i) === "M") i += 1;
		} else if (ch === "$") i += 1;
		else while (/[0-9]/u.test(script.charAt(i))) i += 1;
	};
	for (skipSeparators(); i < script.length; skipSeparators()) {
		skipAddress();
		if (script.charAt(i) === ",") {
			i += 1;
			if (script.charAt(i) === "+" || script.charAt(i) === "~") i += 1;
			skipAddress();
		}
		while (script.charAt(i) === "!" || script.charAt(i) === " ") i += 1;
		const command = script.charAt(i);
		i += 1;
		if (SED_PLAIN_COMMANDS[command] === true) continue;
		if (command === "s" || command === "y") {
			const delimiter = script.charAt(i);
			if (delimiter === "" || delimiter === "\\" || delimiter === "\n" || delimiter === " ") throw new NotProven("a sed command with an unusual delimiter");
			i = sedSection(script, sedSection(script, i + 1, delimiter), delimiter);
			if (command === "s") while (SED_S_FLAGS[script.charAt(i)] === true) i += 1;
			while (script.charAt(i) === " ") i += 1;
			if (i < script.length && script.charAt(i) !== ";" && script.charAt(i) !== "\n") throw new NotProven(`sed ${command} followed by ${script.charAt(i)}`);
			continue;
		}
		throw new NotProven(`the sed command ${command === "" ? "(none)" : command}`);
	}
}

function checkSed(args: readonly string[]): void {
	const scripts: string[] = [];
	let hasExpression = false;
	let scriptTaken = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args.at(i) ?? "";
		if (arg === "--expression") {
			hasExpression = true;
			i += 1;
			scripts.push(args.at(i) ?? "");
		} else if (arg.startsWith("--expression=")) {
			hasExpression = true;
			scripts.push(arg.slice("--expression=".length));
		} else if (arg.startsWith("--")) {
			if (SED_SAFE_LONG[arg] !== true) throw new NotProven(`sed ${arg}`);
		} else if (arg.length > 1 && arg.startsWith("-")) {
			for (let k = 1; k < arg.length; k++) {
				const letter = arg.charAt(k);
				if (letter === "e") {
					hasExpression = true;
					if (k + 1 < arg.length) scripts.push(arg.slice(k + 1));
					else {
						i += 1;
						scripts.push(args.at(i) ?? "");
					}
					break;
				}
				if (SED_SAFE_SHORT[letter] !== true) throw new NotProven(`sed -${letter}`);
			}
		} else if (!hasExpression && !scriptTaken) {
			scriptTaken = true;
			scripts.push(arg);
		}
	}
	if (scripts.length === 0) throw new NotProven("sed without a script");
	for (const script of scripts) checkSedScript(script);
}

function checkSort(args: readonly string[]): void {
	for (let i = 0; i < args.length; i++) {
		const arg = args.at(i) ?? "";
		if (!arg.startsWith("-") || arg === "-") continue;
		if (arg === "-t" || arg === "-k") i += 1;
		else if (arg.startsWith("--") || ![...arg.slice(1)].every((letter) => SORT_SAFE_SHORT[letter] === true)) throw new NotProven(`sort ${arg}`);
	}
}

function checkUnzip(args: readonly string[]): void {
	if (args.some((arg) => arg.startsWith("--"))) throw new NotProven("unzip with a long option");
	const letters = new Set(shortClusters(args).join(""));
	if (letters.has("d") || ![..."plZtvz"].some((mode) => letters.has(mode))) throw new NotProven("unzip that extracts to disk");
}

function checkTar(args: readonly string[]): void {
	const mode = (args.at(0) ?? "").replace(/^-/u, "");
	if (!/^(?=[a-zA-Z]*t)[tvfzjJa]+$/u.test(mode) || args.slice(1).some((arg) => arg.startsWith("-"))) throw new NotProven("tar that is not a listing");
}

function checkGit(args: readonly string[]): void {
	const at = args.at(0) === "-C" ? 2 : 0;
	const subcommand = args.at(at) ?? "";
	if (SAFE_GIT_SUBCOMMANDS[subcommand] !== true) throw new NotProven(`git ${subcommand}`);
	if (args.some((arg) => arg === "-o" || arg.startsWith("--output"))) throw new NotProven("git that writes its output to a file");
}

/** Per-program rules for programs that read or write depending on their options. Each throws when it cannot vouch. */
const checkSevenZip = (args: readonly string[]): void => {
	if (args.at(0) !== "l" && args.at(0) !== "t") throw new NotProven("7z that extracts or changes an archive");
};
const CHECKS: Readonly<Record<string, (args: readonly string[]) => void>> = Object.assign(Object.create(null), {
	find: (args: readonly string[]) => {
		const bad = args.find((arg) => FIND_WRITES_OR_RUNS[arg] === true);
		if (bad !== undefined) throw new NotProven(`find ${bad}`);
	},
	sed: checkSed,
	sort: checkSort,
	unzip: checkUnzip,
	tar: checkTar,
	"7z": checkSevenZip,
	"7za": checkSevenZip,
	"7zz": checkSevenZip,
	"7zr": checkSevenZip,
	git: checkGit,
	pdftotext: (args: readonly string[]) => {
		if (args.length < 2 || args.at(-1) !== "-") throw new NotProven("pdftotext that writes a file");
	},
	date: (args: readonly string[]) => {
		if (!args.every((arg) => arg.startsWith("+") || arg === "-u")) throw new NotProven("date that may set the clock");
	},
	file: (args: readonly string[]) => {
		if (args.includes("--compile") || shortClusters(args).some((cluster) => cluster.includes("C"))) throw new NotProven("file that compiles a magic file");
	},
	tree: (args: readonly string[]) => {
		if (shortClusters(args).some((cluster) => cluster.includes("o"))) throw new NotProven("tree that writes its output to a file");
	},
	base64: (args: readonly string[]) => {
		if (args.some((arg) => arg.startsWith("--output")) || shortClusters(args).some((cluster) => cluster.includes("o"))) throw new NotProven("base64 that writes a file");
	},
	rg: (args: readonly string[]) => {
		if (args.some((arg) => arg.startsWith("--pre") || arg.startsWith("--hostname-bin"))) throw new NotProven("rg that runs a program");
	},
});

/** The program a command word names, or a reason it cannot be trusted to be the system's program of that name. */
function programOf(word: Word): string {
	if (word.dollar) throw new NotProven("a command name the shell expands");
	let name = word.text;
	if (/[\\/]/u.test(name)) {
		const dir = SYSTEM_BIN_DIRS.find((candidate) => name.startsWith(candidate));
		if (dir === undefined || name.slice(dir.length).includes("/")) throw new NotProven(`the program path ${name}`);
		name = name.slice(dir.length);
	}
	return name.toLowerCase().replace(/\.exe$/u, "");
}

function checkSimpleCommand(input: readonly Word[]): void {
	let words = input;
	while (words.length > 0 && !(words.at(0)?.quoted ?? true) && KEYWORDS_BEFORE_COMMAND[words.at(0)?.text ?? ""] === true) words = words.slice(1);
	const first = words.at(0);
	if (first === undefined) return;
	if (!first.quoted && (first.text === "done" || first.text === "fi")) {
		if (words.length > 1) throw new NotProven(`${first.text} followed by more words`);
		return;
	}
	if (!first.quoted && first.text === "for") {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(words.at(1)?.text ?? "") || words.at(2)?.text !== "in") throw new NotProven("a for loop without a word list");
		return;
	}
	if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(first.text) && !first.quoted) throw new NotProven("a variable assignment before a command");
	const program = programOf(first);
	const args = words.slice(1).map((word) => word.text);
	if (ALWAYS_READ_ONLY[program] === true) return;
	const check = CHECKS[program];
	if (check === undefined) throw new NotProven(`${program} is not a program known to only read`);
	check(args);
}

export function analyzeShellCommand(command: string): ShellVerdict {
	try {
		if (command.trim().length === 0) throw new NotProven("an empty command");
		if (SHORTENED.test(command)) throw new NotProven("a command shortened before it was shown");
		for (const segment of tokenize(command)) checkSimpleCommand(segment);
		return { readOnly: true };
	} catch (error) {
		if (error instanceof NotProven) return { readOnly: false, why: error.message };
		throw error;
	}
}
