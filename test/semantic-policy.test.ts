import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AutoRAGAgent,
	buildAgentOptions,
	buildDatasourceSkills,
	DiscrawlClient,
	MailcrawlClient,
	RetrievalMethodRegistry,
	type CliConfig,
	type RefreshMethod,
	type RetrievalMethod,
	type RetrievalMethodDescriptor,
} from "@autorag/librarian";
import { describe, expect, it, vi } from "vitest";
import { createEndpointEmbedder } from "../src/main/embedding-endpoint";
import { readAppIndexing } from "../src/main/app-indexing";
import { agentMinSyncVectorMethod, agentOptionsForSemantic, applySemanticPolicyToAgent, methodsForSemantic, neutralizeSemanticMethods, runWithoutSemanticIndexing, withSemanticPolicyApplied } from "../src/main/semantic-policy";

function config(datasources: CliConfig["datasources"]): CliConfig {
	return { searchPaths: ["/docs"], workspacePath: "/ws", memoryPath: "/ws/memory.json", ...(datasources === undefined ? {} : { datasources }) };
}

describe("appIndexing.semanticSearch", () => {
	it("is on unless the config turns it off, so a config that never mentioned it keeps its semantic search", () => {
		expect(readAppIndexing({}).semanticSearch).toBe(true);
		expect(readAppIndexing({ appIndexing: { excludeCodeFolders: false } }).semanticSearch).toBe(true);
		expect(readAppIndexing({ appIndexing: { semanticSearch: true } }).semanticSearch).toBe(true);
		expect(readAppIndexing({ appIndexing: { semanticSearch: false } }).semanticSearch).toBe(false);
	});

	it("ignores a value that is not a boolean instead of silently switching semantic search off", () => {
		expect(readAppIndexing({ appIndexing: { semanticSearch: "no" } }).semanticSearch).toBe(true);
	});
});

describe("methodsForSemantic", () => {
	it("leaves the methods alone while semantic search is on", () => {
		const methods: RefreshMethod[] = ["parsed", "minsync", "datasources"];
		expect(methodsForSemantic(methods, true)).toEqual(methods);
	});

	it("drops minsync but keeps what a minsync run implied: the parsed mirror and Jikji's keyword index", () => {
		expect(methodsForSemantic(["parsed", "minsync"], false)).toEqual(["parsed", "jikji"]);
		expect(methodsForSemantic(["minsync"], false)).toEqual(["parsed", "jikji"]);
	});

	it("does not add what the caller did not ask for and never repeats a method", () => {
		expect(methodsForSemantic(["datasources"], false)).toEqual(["datasources"]);
		expect(methodsForSemantic(["parsed", "jikji", "minsync"], false)).toEqual(["parsed", "jikji"]);
	});
});

describe("withSemanticPolicyApplied", () => {
	it("returns the very same config while semantic search is on", () => {
		const input = config({ slack: { type: "slack" } });
		expect(withSemanticPolicyApplied(input, true)).toBe(input);
	});

	it.each(["kakao", "slack", "telegram", "whatsapp"])("turns the semantic half of the %s sidecar off", (type) => {
		const effective = withSemanticPolicyApplied(config({ [type]: { type, connector: { syncSource: "wiretap" } } }), false);

		expect(effective.datasources?.[type]).toEqual({ type, connector: { syncSource: "wiretap", sidecar: { semantic: false } } });
	});

	it("resolves the template from the alias when the entry has no type, and keeps other sidecar options", () => {
		const effective = withSemanticPolicyApplied(config({ slack: { connector: { sidecar: { crawlerDbPath: "/x.db" } } } }), false);

		expect(effective.datasources?.slack).toEqual({ connector: { sidecar: { crawlerDbPath: "/x.db", semantic: false } } });
	});

	it("keeps a sidecar the user switched off entirely switched off", () => {
		const effective = withSemanticPolicyApplied(config({ slack: { type: "slack", connector: { sidecar: false } } }), false);

		expect(effective.datasources?.slack).toEqual({ type: "slack", connector: { sidecar: false } });
	});

	it("makes Discord answer from its full-text index and ClawGallery skip its visual vector sync", () => {
		const effective = withSemanticPolicyApplied(
			config({ discord: { instanceId: "default", connector: {} }, gallery: { type: "clawgallery", connector: { syncVisual: true } } }),
			false,
		);

		expect(effective.datasources?.discord).toEqual({ instanceId: "default", connector: { defaultMode: "fts" } });
		expect(effective.datasources?.gallery).toEqual({ type: "clawgallery", connector: { syncVisual: false, defaultMode: "keyword" } });
	});

	it("leaves an Obsidian vault unindexed, since MinSync cannot index without an embedder", () => {
		const effective = withSemanticPolicyApplied(config({ vault: { type: "obsidian", connector: { vaultPath: "/vault" } } }), false);

		expect(effective.datasources?.vault).toEqual({ type: "obsidian", enabled: false, connector: { vaultPath: "/vault" } });
	});

	it("asks github-gist to stay lexical-only through connector.semantic", () => {
		const effective = withSemanticPolicyApplied(config({ "my-gists": { type: "github-gist", connector: { tokenEnv: "GH" } }, "github-gist": {} }), false);

		expect(effective.datasources?.["my-gists"]).toEqual({ type: "github-gist", connector: { tokenEnv: "GH", semantic: false } });
		expect(effective.datasources?.["github-gist"]).toEqual({ connector: { semantic: false } });
	});

	it("leaves sources that never embed untouched and does not mutate its input", () => {
		const input = config({ github: { type: "github", connector: { repos: ["a/b"] } }, slack: { type: "slack" }, off: false });

		const effective = withSemanticPolicyApplied(input, false);

		expect(effective.datasources?.github).toEqual({ type: "github", connector: { repos: ["a/b"] } });
		expect(effective.datasources?.off).toBe(false);
		expect(input.datasources?.slack).toEqual({ type: "slack" });
	});
});

function method(name: string, type: RetrievalMethodDescriptor["type"], calls: string[], datasourceId?: string): RetrievalMethod {
	return {
		describe: () => ({ name, type, description: name, status: "active", capabilities: [], ...(datasourceId === undefined ? {} : { datasourceId }) }),
		retrieve: async () => {
			calls.push(name);
			return [{ id: name, content: name, source: "/a", score: 1, metadata: {} }];
		},
	};
}

describe("neutralizeSemanticMethods", () => {
	it("makes every vector and hybrid method answer nothing without running it, and keeps lexical ones", async () => {
		const calls: string[] = [];
		const registry = new RetrievalMethodRegistry();
		for (const m of [method("minsync", "vector", calls), method("minsync-hybrid", "hybrid", calls), method("posix", "posix", calls), method("slack-sidecar-bm25", "bm25", calls)]) registry.register(m);

		const neutralized = neutralizeSemanticMethods(registry);

		expect(neutralized).toEqual(["minsync", "minsync-hybrid"]);
		const answers = await Promise.all(registry.list().map((m) => m.retrieve("q", {})));
		expect(answers.map((a) => a.length)).toEqual([0, 0, 1, 1]);
		expect(calls).toEqual(["posix", "slack-sidecar-bm25"]);
	});

	it("keeps each method's descriptor so tool listings and diagnostics stay truthful", () => {
		const registry = new RetrievalMethodRegistry();
		registry.register(method("minsync", "vector", []));

		neutralizeSemanticMethods(registry);

		expect(registry.get("minsync")?.describe()).toMatchObject({ name: "minsync", type: "vector" });
	});

	it("keeps a datasource's hybrid method running, since it answers from keyword search by itself, and silences every other semantic method", async () => {
		const calls: string[] = [];
		const registry = new RetrievalMethodRegistry();
		for (const m of [method("hybrid", "hybrid", calls), method("kakao-semantic", "vector", calls, "kakao"), method("mail-hybrid", "hybrid", calls, "mail")]) registry.register(m);

		expect(neutralizeSemanticMethods(registry)).toEqual(["hybrid", "kakao-semantic"]);
		const answers = await Promise.all(registry.list().map((m) => m.retrieve("q", {})));

		expect(answers.map((a) => a.length)).toEqual([0, 0, 1]);
		expect(calls).toEqual(["mail-hybrid"]);
	});

	it("does not let the pipeline report a datasource's deliberate keyword fallback as a failed method", async () => {
		const seen: Array<{ readonly onFallback: unknown; readonly topK: number | undefined }> = [];
		const hybrid: RetrievalMethod = {
			describe: () => ({ name: "mail-hybrid", type: "hybrid", description: "mail", status: "active", capabilities: [], datasourceId: "mail" }),
			retrieve: async (_query, options) => {
				seen.push({ onFallback: options.onFallback, topK: options.topK });
				return [];
			},
		};
		const registry = new RetrievalMethodRegistry();
		registry.register(hybrid);

		neutralizeSemanticMethods(registry);
		await hybrid.retrieve("q", { topK: 7, onFallback: () => undefined });

		expect(seen).toEqual([{ onFallback: undefined, topK: 7 }]);
	});
});

describe.skipIf(process.platform === "win32")("a hybrid-first datasource in keyword-only mode", () => {
	const HIT = `[{"chunkId":"c1","messageId":"m1","threadId":"t1","accountId":"qa","mailbox":"INBOX","subject":"Invoice QZ-7741","from":"billing@quartz.example","to":["me@example.test"],"date":"2026-10-12T00:00:00.000Z","snippet":"Invoice QZ-7741 is due 2026-11-30","score":1,"mode":"bm25"}]`;

	it("searches the mailbox by keyword only: mailcrawl is never asked for hybrid, and nothing is reported as a failed method", async () => {
		const root = await mkdtemp(join(tmpdir(), "autorag-mail-keyword-"));
		try {
			const log = join(root, "calls.log");
			const binaryPath = join(root, "mailcrawl");
			await writeFile(binaryPath, `#!/bin/sh\necho "$@" >> '${log}'\ncat <<'JSON'\n${HIT}\nJSON\n`, { mode: 0o755 });
			const minsync = join(root, "minsync");
			await writeFile(minsync, `#!/bin/sh\necho "$@" >> '${join(root, "minsync.log")}'\nexit 1\n`, { mode: 0o755 });
			const workspacePath = join(root, "workspace");
			await mkdir(workspacePath);
			const base = buildAgentOptions({
				searchPaths: [root],
				workspacePath: root,
				memoryPath: join(root, "memory.json"),
				datasources: { mail: { type: "mailcrawl", connector: { binaryPath, dataDir: join(root, "mail"), account: "qa" } } },
			});
			const options = { ...base, minSync: { ...base.minSync, binaryPath: minsync, workspacePath } };
			const agent = new AutoRAGAgent(agentOptionsForSemantic(options, false));
			applySemanticPolicyToAgent(agent, false);

			const { results, diagnostics } = await agent.retrieveWithDiagnostics("invoice QZ-7741", { topK: 5 });

			expect(results.map((result) => result.content)).toContain("Invoice QZ-7741 is due 2026-11-30");
			const calls = (await readFile(log, "utf8")).trim().split("\n");
			expect(calls.every((call) => call.includes("--mode bm25"))).toBe(true);
			expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain("retrieval-method-failed");
			expect(await stat(join(root, "minsync.log")).then(() => true, () => false)).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("runWithoutSemanticIndexing", () => {
	const mailcrawlIndex = MailcrawlClient.prototype.index;
	const discrawlEmbed = DiscrawlClient.prototype.embed;

	it("lets the connectors sync and update but turns each one's embedding step into a successful no-op", async () => {
		await runWithoutSemanticIndexing(async () => {
			const mail = await new MailcrawlClient({}).index();
			const chat = await new DiscrawlClient({}).embed();

			expect(mail).toMatchObject({ ok: true });
			expect(chat).toMatchObject({ ok: true, data: { processed: 0, failed: 0, remainingBacklog: 0 } });
		});
	});

	it("puts the real embedding steps back afterwards, including when the work throws", async () => {
		await expect(runWithoutSemanticIndexing(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");

		expect(MailcrawlClient.prototype.index).toBe(mailcrawlIndex);
		expect(DiscrawlClient.prototype.embed).toBe(discrawlEmbed);
	});

	it("restores them only once the last of several overlapping runs has finished", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = runWithoutSemanticIndexing(() => gate);
		const second = runWithoutSemanticIndexing(async () => undefined);
		await second;

		expect(MailcrawlClient.prototype.index).not.toBe(mailcrawlIndex);

		release();
		await first;

		expect(MailcrawlClient.prototype.index).toBe(mailcrawlIndex);
	});

	it("never spawns the connector binaries for the skipped steps", async () => {
		const spawnSpy = vi.spyOn(MailcrawlClient.prototype as unknown as { run: () => Promise<unknown> }, "run");
		try {
			await runWithoutSemanticIndexing(() => new MailcrawlClient({}).index());
			expect(spawnSpy).not.toHaveBeenCalled();
		} finally {
			spawnSpy.mockRestore();
		}
	});
});

describe("keyword-only search agent", () => {
	async function agentFor(semantic: boolean, minSync?: { readonly binaryPath: string; readonly workspacePath: string }): Promise<{ readonly agent: AutoRAGAgent; readonly cleanup: () => Promise<void> }> {
		const root = await mkdtemp(join(tmpdir(), "autorag-semantic-agent-"));
		await writeFile(join(root, "note.md"), "quarterly revenue report");
		const base = buildAgentOptions({ searchPaths: [root], workspacePath: root, memoryPath: join(root, "memory.json") });
		const options = { ...base, ...(minSync === undefined ? {} : { minSync: { ...base.minSync, ...minSync } }) };
		const agent = new AutoRAGAgent(agentOptionsForSemantic(options, semantic));
		applySemanticPolicyToAgent(agent, semantic);
		return { agent, cleanup: () => rm(root, { recursive: true, force: true }) };
	}

	/** The vector method the agent keeps outside its registry; it must be found on a real agent, or keyword-only mode cannot silence it. */
	function vectorMethodOf(agent: AutoRAGAgent): RetrievalMethod {
		const found = agentMinSyncVectorMethod(agent);
		if (found === undefined) throw new Error("the librarian's agent no longer carries a MinSync vector method");
		return found;
	}

	it("answers nothing from MinSync's hybrid method", async () => {
		const { agent, cleanup } = await agentFor(false);
		try {
			const registry = agent.getMethodRegistry();
			expect(registry.get("hybrid")?.describe().type).toBe("hybrid");
			expect(await registry.get("hybrid")?.retrieve("revenue", {})).toEqual([]);
		} finally {
			await cleanup();
		}
	});

	it("keeps MinSync's methods live while semantic search is on", async () => {
		const { agent, cleanup } = await agentFor(true);
		try {
			expect(vectorMethodOf(agent).describe().type).toBe("vector");
			expect(Object.hasOwn(vectorMethodOf(agent) as object, "retrieve")).toBe(false);
			expect(Object.hasOwn(agent.getMethodRegistry().get("hybrid") as object, "retrieve")).toBe(false);
		} finally {
			await cleanup();
		}
	});

	it.skipIf(process.platform === "win32")("answers nothing from the agent's own MinSync vector method and never spawns minsync for it", async () => {
		const dir = await mkdtemp(join(tmpdir(), "autorag-fake-minsync-"));
		const marker = join(dir, "spawned");
		const binaryPath = join(dir, "minsync");
		await writeFile(binaryPath, `#!/bin/sh\necho "$@" >> '${marker}'\nexit 1\n`, { mode: 0o755 });
		// The binary runs in the workspace directory, which MinSync only creates on its first sync.
		const workspacePath = join(dir, "workspace");
		await mkdir(workspacePath);
		const spawned = () => stat(marker).then(() => true, () => false);
		const keywordOnly = await agentFor(false, { binaryPath, workspacePath });
		const semantic = await agentFor(true, { binaryPath, workspacePath });
		try {
			expect(await vectorMethodOf(keywordOnly.agent).retrieve("revenue", {})).toEqual([]);
			expect(await spawned()).toBe(false);

			// Control: with semantic search on, the same call does reach the binary.
			await expect(vectorMethodOf(semantic.agent).retrieve("revenue", {})).rejects.toThrow();
			expect(await spawned()).toBe(true);
		} finally {
			await keywordOnly.cleanup();
			await semantic.cleanup();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("refuses to run keyword-only on a librarian whose agent no longer exposes the vector method, instead of silently searching by meaning", () => {
		const agent = { getMethodRegistry: () => new RetrievalMethodRegistry() };

		expect(() => applySemanticPolicyToAgent(agent, false)).toThrow(/minSyncMethod/);
		expect(() => applySemanticPolicyToAgent(agent, true)).not.toThrow();
	});

	it("keeps memory search keyword-only only when semantic search is off", () => {
		expect(agentOptionsForSemantic({ searchPaths: [] }, false).memoryEmbedder).toBe(false);
		expect("memoryEmbedder" in agentOptionsForSemantic({ searchPaths: [] }, true)).toBe(false);
	});

	it("tells the datasource CLIs there is no embedding endpoint only when semantic search is off", async () => {
		const input = { searchPaths: [], workspacePath: "/ws", memoryPath: "/ws/memory.json" };
		const keywordOnly = buildAgentOptions(input);
		const semantic = buildAgentOptions(input);
		const original = semantic.embedder?.describeEndpoint;
		const untouched = keywordOnly.embedder?.describeEndpoint;

		agentOptionsForSemantic(keywordOnly, false);
		agentOptionsForSemantic(semantic, true);

		expect(keywordOnly.embedder?.describeEndpoint).not.toBe(untouched);
		expect(await keywordOnly.embedder?.describeEndpoint()).toBeUndefined();
		expect(semantic.embedder?.describeEndpoint).toBe(original);
	});
});

describe("GitHub Gist in keyword-only mode", () => {
	const GIST = { id: "g1", description: "notes", public: false, updated_at: "2026-01-01T00:00:00.000Z", html_url: "https://gist.github.com/g1", files: { "a.md": { filename: "a.md", truncated: false } } };
	const FULL = { ...GIST, files: { "a.md": { filename: "a.md", content: "zebracorn migration notes", truncated: false } } };
	const fetchImpl = (async (url: string | URL | Request) => {
		const href = String(url);
		const body = href.includes("/gists/g1") ? FULL : [GIST];
		return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	}) as typeof fetch;

	async function indexGist(semantic: boolean): Promise<{ readonly diagnostics: readonly string[]; readonly vectors: boolean; readonly ok: boolean; readonly methods: readonly string[] }> {
		const root = await mkdtemp(join(tmpdir(), "autorag-gist-"));
		const previousHome = process.env.AUTORAG_HOME;
		// No cached embedding runtime in here: an embedding attempt can only end as `semantic-unavailable`, never start a model.
		process.env.AUTORAG_HOME = join(root, "home");
		try {
			const connector = { baseUrl: "https://gist.test", token: "t", ghCliFallback: false, fetchImpl };
			const { datasources } = withSemanticPolicyApplied(config({ "github-gist": { connector } }), semantic);
			const { skills } = buildDatasourceSkills(datasources ?? {}, root);
			const result = await skills[0]!.index();
			const vectors = await stat(join(root, ".autorag", "datasources", "github-gist", "default", "vectors.json")).then(() => true, () => false);
			return { ok: result.ok, diagnostics: result.diagnostics.map((d) => d.message), vectors, methods: skills[0]!.retrievalMethods().map((method) => method.describe().type) };
		} finally {
			if (previousHome === undefined) delete process.env.AUTORAG_HOME;
			else process.env.AUTORAG_HOME = previousHome;
			await rm(root, { recursive: true, force: true });
		}
	}

	it("indexes the gist's content but builds no vector index and registers no semantic method", async () => {
		const outcome = await indexGist(false);

		expect(outcome.ok).toBe(true);
		expect(outcome.diagnostics.some((message) => message.includes("semantic-unavailable"))).toBe(false);
		expect(outcome.vectors).toBe(false);
		expect(outcome.methods).not.toContain("vector");
		expect(outcome.methods).not.toContain("hybrid");
	});

	it("keeps the gist's semantic method while semantic search is on", () => {
		const { datasources } = withSemanticPolicyApplied(config({ "github-gist": {} }), true);
		// The librarian registers the gist's semantic method only when a shared embedder is passed, as the app does.
		const embedder = createEndpointEmbedder(async () => undefined, {});
		const { skills } = buildDatasourceSkills(datasources ?? {}, "/tmp/autorag-gist-semantic-on", { embedder });

		expect(skills[0]!.retrievalMethods().map((method) => method.describe().type)).toContain("vector");
	});
});
