import { execFileSync } from "node:child_process";

/**
 * Synthetic ranking-log runs for the learning-to-rank QA lanes, written straight into the librarian's SQLite file in its
 * record shape (schemaVersion 1). A lane with no model cannot produce real runs; a change to the librarian's record shape
 * makes it refuse these rows, which shows up as a wrong "searches logged" count.
 *
 * The signal is planted on purpose: one chunk per run is the answer, the reranker ranks it first only about half the
 * time, and the logged dense rank says where it really is, so a model can learn to move it up. Nothing here says
 * anything about how a model does on real searches; it only gives the pipeline a log a model can pass on.
 *
 * `startedAt` is where the first run's clock starts (later runs follow a minute apart); runs written later than the
 * existing ones land in the newest 20% that the librarian holds out. Re-seeding with the same `idPrefix` and indexes is
 * a no-op (`INSERT OR IGNORE`).
 */
export function seedSyntheticLog({ memoryPath, count, idPrefix = "qa", startedAt = 1_800_000_000_000 }) {
	const script = `
		const { DatabaseSync } = require("node:sqlite");
		const db = new DatabaseSync(process.argv[1] + ".ranking.db");
		db.exec("PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, record TEXT NOT NULL) WITHOUT ROWID;");
		const insert = db.prepare("INSERT OR IGNORE INTO runs (run_id, started_at, record) VALUES (?, ?, ?)");
		const count = Number(process.argv[2]);
		const prefix = process.argv[3];
		const origin = Number(process.argv[4]);
		let seed = 7;
		const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
		for (let i = 0; i < count; i += 1) {
			const startedAt = origin + i * 60_000;
			const size = 8;
			const gold = Math.floor(rand() * size);
			const rerankOrder = [...Array(size).keys()].sort((a, b) => (a === gold ? (rand() < 0.5 ? -2 : 0.5) : rand()) - (b === gold ? (rand() < 0.5 ? -2 : 0.5) : rand()));
			const candidates = rerankOrder.map((chunk, position) => {
				const isGold = chunk === gold;
				const denseRank = isGold ? 1 + Math.floor(rand() * 2) : 1 + Math.floor(rand() * size);
				return {
					chunkId: prefix + String(i).padStart(4, "0") + String(chunk),
					source: "/qa/doc" + chunk + ".md",
					origin: "local files",
					contentChars: 400,
					observations: [{ stage: "prefetch", surface: "minsync", method: "minsync-dense", query: "q" + i, rank: denseRank, score: 1 - denseRank / 20 }],
					rerank: { rank: position + 1, score: 1 - position / 10 },
					exposures: [{ surface: "baseline", query: "q" + i, position: position + 1 }],
					text: { bm25: rand(), questionCoverage: rand() },
					memory: { priorSupport: 0, similarQuestionSupport: null },
					labels: { citedFinal: isGold, modelCited: isGold },
				};
			});
			const record = { schemaVersion: 1, runId: prefix + "-" + i, conversationId: prefix, question: "q" + i, startedAt, finishedAt: startedAt + 1000, searchQueries: ["q" + i], datasources: [], web: false, reranker: { provider: "openrouter", model: "qa/rerank" }, judgments: { citationRelevance: "not-run", support: "not-run" }, candidates };
			insert.run(record.runId, record.startedAt, JSON.stringify(record));
		}
		db.close();
	`;
	execFileSync(process.execPath, ["-e", script, memoryPath, String(count), idPrefix, String(startedAt)], { stdio: ["ignore", "pipe", "inherit"] });
}
