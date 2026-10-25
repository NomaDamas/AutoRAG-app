import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";

/**
 * Which pi session file holds each chat's conversation.
 *
 * A chat in AI Search is one model conversation (see `InteractiveSearchAgent`), kept by pi in a session file so it
 * resumes after a restart. pi names the files itself, so the chat keeps its file's name here, in `index.json` beside
 * the files. Names are stored, not paths: the whole folder moves with the app's data.
 */
export interface ChatSessionIndex {
	/** The chat's session file, when it has one and the file still exists. */
	fileFor(chatId: string): Promise<string | null>;
	remember(chatId: string, file: string): Promise<void>;
	/** Forgets every chat's conversation and deletes the session files. */
	clear(): Promise<void>;
}

export interface ChatSessionIndexDeps {
	/** The folder pi keeps the session files in; the index lives in it. */
	readonly directory: string;
}

const INDEX_FILENAME = "index.json";

const indexSchema = Type.Object({ version: Type.Literal(1), chats: Type.Record(Type.String(), Type.String()) });

export function createChatSessionIndex(deps: ChatSessionIndexDeps): ChatSessionIndex {
	const indexPath = join(deps.directory, INDEX_FILENAME);
	let loaded: Promise<Record<string, string>> | undefined;
	// Writes run one at a time: each one saves everything the earlier ones recorded.
	let queue: Promise<unknown> = Promise.resolve();

	async function load(): Promise<Record<string, string>> {
		try {
			const parsed: unknown = JSON.parse(await readFile(indexPath, "utf8"));
			return Value.Check(indexSchema, parsed) ? { ...parsed.chats } : {};
		} catch {
			// No index yet, or a damaged one: chats start new conversations, and the next write rebuilds it.
			return {};
		}
	}

	const chats = (): Promise<Record<string, string>> => (loaded ??= load());

	async function save(next: Record<string, string>): Promise<void> {
		await mkdir(deps.directory, { recursive: true });
		const temporary = `${indexPath}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify({ version: 1, chats: next })}\n`, "utf8");
		await rename(temporary, indexPath);
	}

	return {
		fileFor: async (chatId) => {
			const name = (await chats())[chatId];
			if (name === undefined) return null;
			const file = join(deps.directory, name);
			return existsSync(file) ? file : null;
		},
		remember: (chatId, file) => {
			const run = async (): Promise<void> => {
				const next = { ...(await chats()), [chatId]: basename(file) };
				loaded = Promise.resolve(next);
				await save(next);
			};
			const result = queue.then(run, run);
			queue = result.catch(() => undefined);
			return result;
		},
		clear: () => {
			const run = async (): Promise<void> => {
				loaded = Promise.resolve({});
				await rm(deps.directory, { recursive: true, force: true });
			};
			const result = queue.then(run, run);
			queue = result.catch(() => undefined);
			return result;
		},
	};
}
