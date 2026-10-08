import { describe, expect, it } from "vitest";
import { detectSources } from "../src/main/onboarding-sources";

function deps(run: (command: string, args: readonly string[]) => Promise<string>) {
	return {
		platform: "linux" as const,
		home: "/home/test",
		env: { GITHUB_TOKEN: "test-token" },
		run,
		pathExists: async () => false,
		readDirNames: async () => [],
		readFileText: async () => {
			throw new Error("not configured");
		},
	};
}

describe("onboarding datasource detection", () => {
	it.each([
		["empty repository list", "[]"],
		["malformed discovery output", "not-json"],
		["failed discovery command", null],
	])("does not offer authenticated GitHub after %s", async (_name, output) => {
		const result = await detectSources(
			deps(async (command, args) => {
				if (command === "gh" && args[0] === "repo" && output !== null) return output;
				throw new Error(`unexpected probe: ${command} ${args.join(" ")}`);
			}),
		);

		expect(result.sources.some((source) => source.id === "github")).toBe(false);
	});

	it("bounds repository discovery to five indexing targets", async () => {
		const repos = Array.from({ length: 7 }, (_, index) => `me/repo-${index}`);
		const result = await detectSources(
			deps(async (command, args) => {
				if (command === "gh" && args[0] === "repo") return JSON.stringify(repos.map((nameWithOwner) => ({ nameWithOwner })));
				throw new Error(`unexpected probe: ${command} ${args.join(" ")}`);
			}),
		);
		const github = result.sources.find((source) => source.id === "github");

		expect(github?.facts.repos).toEqual(repos.slice(0, 5));
	});

	const ok = (value: unknown): string => JSON.stringify(value);
	const ids = (result: { sources: readonly { id: string }[] }): string[] => result.sources.map((source) => source.id);
	/** Runs only the probes the test scripts; anything else behaves like a missing CLI. */
	const script =
		(handlers: Record<string, (args: readonly string[]) => string>) =>
		async (command: string, args: readonly string[]): Promise<string> => {
			const handler = handlers[command];
			if (handler === undefined) throw new Error(`${command}: command not found`);
			return handler(args);
		};
	const noGithub = { env: {} as NodeJS.ProcessEnv };

	it("offers neither Spotlight nor Apple Mail, even on macOS with a Mail folder", async () => {
		const result = await detectSources({
			...deps(script({ mdfind: () => "0", which: () => "/usr/bin/x" })),
			...noGithub,
			platform: "darwin",
			pathExists: async () => true,
			readDirNames: async () => ["V10"],
		});

		expect(ids(result)).toEqual([]);
	});

	it("lists a mailcrawl row only with the himalaya accounts that really log in", async () => {
		const result = await detectSources({
			...deps(
				script({
					which: () => "/opt/homebrew/bin/mailcrawl",
					himalaya: (args) => {
						if (args[0] === "account") return ok({ accounts: [{ name: "gmail" }, { name: "stale" }, { name: "bad name!" }] });
						if (args[3] === "gmail") return ok([]);
						throw new Error("authentication failed");
					},
				}),
			),
			...noGithub,
		});

		expect(result.sources).toEqual([{ id: "mailcrawl", facts: { accounts: ["gmail"] } }]);
	});

	it("hides mailcrawl when the binary is missing or no account can log in", async () => {
		const accountsOnly = script({ himalaya: (args) => (args[0] === "account" ? ok({ accounts: [{ name: "gmail" }] }) : "") });
		expect(ids(await detectSources({ ...deps(accountsOnly), ...noGithub }))).toEqual([]);

		const allFail = script({
			which: () => "/opt/homebrew/bin/mailcrawl",
			himalaya: (args) => {
				if (args[0] === "account") return ok({ accounts: [{ name: "gmail" }] });
				throw new Error("authentication failed");
			},
		});
		expect(ids(await detectSources({ ...deps(allFail), ...noGithub }))).toEqual([]);
	});

	it("detects messenger archives from each CLI's own health output", async () => {
		const result = await detectSources({
			...deps(
				script({
					discrawl: (args) => (args.includes("doctor") ? ok({ config: "ok", database: "ok" }) : ok({ messages: 807, dry_run: true })),
					telecrawl: () => ok({ exists: true, accessible: true, store: "telegram-macos-postbox" }),
					wacrawl: () => ok({ desktop: { available: true, message_rows: 16591, chat_rows: 24 } }),
				}),
			),
			...noGithub,
		});

		expect(result.sources).toEqual([
			{ id: "discord", facts: { messages: 807 } },
			{ id: "telegram", facts: {} },
			{ id: "whatsapp", facts: { chats: 24, messages: 16591 } },
		]);
	});

	it.each([
		["discord with an empty cache", "discrawl", (args: readonly string[]) => (args.includes("doctor") ? ok({ config: "ok", database: "ok" }) : ok({ messages: 0 }))],
		["discord with no ready archive database", "discrawl", () => ok({ config: "ok", database: "missing", messages: 5 })],
		["telegram with no local store", "telecrawl", () => ok({ exists: false, accessible: false, store: "missing" })],
		["whatsapp without the desktop app", "wacrawl", () => ok({ desktop: { available: false } })],
		["whatsapp with an empty desktop database", "wacrawl", () => ok({ desktop: { available: true, message_rows: 0 } })],
	])("hides %s", async (_name, command, handler) => {
		const result = await detectSources({ ...deps(script({ [command]: handler })), ...noGithub });

		expect(ids(result)).toEqual([]);
	});

	it("detects KakaoTalk only on macOS with a cached login and readable data", async () => {
		const probe = (macos: Record<string, unknown>) =>
			script({ lazykatok: () => ok({ source_adapter: { macos: { status: "checked", ...macos } } }) });
		const ready = { app_installed: true, container_present: true, auth_cached: true, db_file_count: 2 };

		expect(ids(await detectSources({ ...deps(probe(ready)), ...noGithub, platform: "darwin" }))).toEqual(["kakao"]);
		expect(ids(await detectSources({ ...deps(probe(ready)), ...noGithub, platform: "linux" }))).toEqual([]);
		expect(ids(await detectSources({ ...deps(probe({ ...ready, auth_cached: false })), ...noGithub, platform: "darwin" }))).toEqual([]);
		expect(ids(await detectSources({ ...deps(probe({ ...ready, db_file_count: 0 })), ...noGithub, platform: "darwin" }))).toEqual([]);
	});

	it("keeps a failing probe from hiding the others", async () => {
		const result = await detectSources({
			...deps(
				script({
					discrawl: () => {
						throw new Error("boom");
					},
					telecrawl: () => ok({ exists: true, accessible: true, store: "telegram-macos-postbox" }),
				}),
			),
			...noGithub,
		});

		expect(ids(result)).toEqual(["telegram"]);
	});
});
