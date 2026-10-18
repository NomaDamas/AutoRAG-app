import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AutoRAGAgent,
	buildAgentOptions,
	DiscrawlClient,
	MailcrawlClient,
	QmdClient,
	RetrievalMethodRegistry,
	type CliConfig,
	type RefreshMethod,
	type RetrievalMethod,
	type RetrievalMethodDescriptor,
} from "@autorag/librarian";
import { describe, expect, it, vi } from "vitest";
import { readAppIndexing } from "../src/main/app-indexing";
import { agentOptionsForSemantic, applySemanticPolicyToAgent, methodsForSemantic, neutralizeSemanticMethods, runWithoutSemanticIndexing, withSemanticPolicyApplied } from "../src/main/semantic-policy";

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
		expect(effective.datasources?.gallery).toEqual({ type: "clawgallery", connector: { syncVisual: false } });
	});

	it("leaves sources that never embed untouched and does not mutate its input", () => {
		const input = config({ github: { type: "github", connector: { repos: ["a/b"] } }, slack: { type: "slack" }, off: false });

		const effective = withSemanticPolicyApplied(input, false);

		expect(effective.datasources?.github).toEqual({ type: "github", connector: { repos: ["a/b"] } });
		expect(effective.datasources?.off).toBe(false);
		expect(input.datasources?.slack).toEqual({ type: "slack" });
	});
});

function method(name: string, type: RetrievalMethodDescriptor["type"], calls: string[]): RetrievalMethod {
	return {
		describe: () => ({ name, type, description: name, status: "active", capabilities: [] }),
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
});

describe("runWithoutSemanticIndexing", () => {
	const mailcrawlIndex = MailcrawlClient.prototype.index;
	const qmdEmbed = QmdClient.prototype.embed;
	const discrawlEmbed = DiscrawlClient.prototype.embed;

	it("lets the connectors sync and update but turns each one's embedding step into a successful no-op", async () => {
		await runWithoutSemanticIndexing(async () => {
			const mail = await new MailcrawlClient({}).index();
			const notes = await new QmdClient({ vaultPath: "/vault", instanceId: "v" }).embed();
			const chat = await new DiscrawlClient({}).embed();

			expect(mail).toMatchObject({ ok: true });
			expect(notes).toMatchObject({ ok: true, data: { embedded: false } });
			expect(chat).toMatchObject({ ok: true, data: { processed: 0, failed: 0, remainingBacklog: 0 } });
		});
	});

	it("puts the real embedding steps back afterwards, including when the work throws", async () => {
		await expect(runWithoutSemanticIndexing(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");

		expect(MailcrawlClient.prototype.index).toBe(mailcrawlIndex);
		expect(QmdClient.prototype.embed).toBe(qmdEmbed);
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
	async function agentFor(semantic: boolean): Promise<{ readonly agent: AutoRAGAgent; readonly cleanup: () => Promise<void> }> {
		const root = await mkdtemp(join(tmpdir(), "autorag-semantic-agent-"));
		await writeFile(join(root, "note.md"), "quarterly revenue report");
		const options = { ...buildAgentOptions({ searchPaths: [root], workspacePath: root, memoryPath: join(root, "memory.json") }) };
		const agent = new AutoRAGAgent(agentOptionsForSemantic(options, semantic));
		applySemanticPolicyToAgent(agent, semantic);
		return { agent, cleanup: () => rm(root, { recursive: true, force: true }) };
	}

	it("answers nothing from MinSync's vector and hybrid methods and does not spawn minsync for them", async () => {
		const { agent, cleanup } = await agentFor(false);
		try {
			const registry = agent.getMethodRegistry();
			expect(registry.get("minsync")?.describe().type).toBe("vector");
			expect(await registry.get("minsync")?.retrieve("revenue", {})).toEqual([]);
			expect(await registry.get("hybrid")?.retrieve("revenue", {})).toEqual([]);
		} finally {
			await cleanup();
		}
	});

	it("keeps MinSync's methods live while semantic search is on", async () => {
		const { agent, cleanup } = await agentFor(true);
		try {
			const retrieve = agent.getMethodRegistry().get("minsync")?.retrieve;
			expect(retrieve?.constructor.name).toBe("AsyncFunction");
			expect(Object.hasOwn(agent.getMethodRegistry().get("minsync") as object, "retrieve")).toBe(false);
		} finally {
			await cleanup();
		}
	});

	it("keeps memory search keyword-only only when semantic search is off", () => {
		expect(agentOptionsForSemantic({ searchPaths: [] }, false).memoryEmbedder).toBe(false);
		expect("memoryEmbedder" in agentOptionsForSemantic({ searchPaths: [] }, true)).toBe(false);
	});
});
