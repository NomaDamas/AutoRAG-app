import { describe, expect, it } from "vitest";
import { createDemoHunt, type DemoDoc, type DemoHuntDeps } from "../src/main/demo-question-hunt";
import { createDemoQuestionJudge, readNoulScore } from "../src/main/demo-question-judge";

const doc = (name: string): DemoDoc => ({ sourcePath: `/docs/${name}`, realSourcePath: `/docs/${name}`, excerpt: `excerpt of ${name}` });

function hunt(overrides: Partial<DemoHuntDeps> & { readonly docs: readonly DemoDoc[]; readonly scores: Readonly<Record<string, number | null>> }) {
	const { docs, scores, ...rest } = overrides;
	const wrote: string[][] = [];
	let clock = 0;
	const deps: DemoHuntDeps = {
		collect: (seen) => docs.filter((candidate) => !seen.has(candidate.sourcePath)),
		write: async (given) => {
			wrote.push(given.map((candidate) => candidate.sourcePath));
			return given.map((candidate, index) => ({ doc: index + 1, question: `q:${candidate.sourcePath.split("/").pop()}` }));
		},
		retrieve: async (query) => [{ source: `/docs/${query.slice(2)}` }],
		judge: async (candidates) => candidates.map((candidate) => scores[candidate.question] ?? null),
		realpath: (path) => path,
		minScore: 0.9,
		maxDocs: 10,
		batchSize: 2,
		now: () => (clock += 1),
		...rest,
	};
	return { instance: createDemoHunt(deps), wrote };
}

describe("createDemoHunt", () => {
	it("takes no question below the bar and keeps looking at new documents until one clears it", async () => {
		const { instance, wrote } = hunt({ docs: [doc("a"), doc("b"), doc("c"), doc("d")], scores: { "q:a": 0.8, "q:b": 0.89, "q:c": 0.95, "q:d": 0.92 } });
		expect((await instance.round(false)).demo).toBeNull();
		const second = await instance.round(false);
		expect(second.demo?.question).toBe("q:c");
		expect(wrote).toEqual([["/docs/a", "/docs/b"], ["/docs/c", "/docs/d"]]);
	});

	it("picks the highest score of a round, not the first over the bar", async () => {
		const { instance } = hunt({ docs: [doc("a"), doc("b")], scores: { "q:a": 0.91, "q:b": 0.97 } });
		expect((await instance.round(false)).demo?.question).toBe("q:b");
	});

	it("holds a question whose document is not searchable yet and judges it once it is", async () => {
		let indexed = false;
		const { instance } = hunt({
			docs: [doc("a")],
			scores: { "q:a": 0.95 },
			retrieve: async (query) => (indexed ? [{ source: `/docs/${query.slice(2)}` }] : []),
		});
		const early = await instance.round(false);
		expect(early.demo).toBeNull();
		expect(early.exhausted).toBe(false);
		indexed = true;
		expect((await instance.round(false)).demo?.question).toBe("q:a");
	});

	it("drops a question that the finished index does not answer from its own document", async () => {
		const { instance } = hunt({ docs: [doc("a")], scores: { "q:a": 0.99 }, retrieve: async () => [{ source: "/elsewhere.pdf" }] });
		await instance.round(true);
		const round = await instance.round(true);
		expect(round.demo).toBeNull();
		expect(round.exhausted).toBe(true);
	});

	it("never asks the model about a document twice", async () => {
		const { instance, wrote } = hunt({ docs: [doc("a")], scores: { "q:a": 0.5 } });
		await instance.round(false);
		await instance.round(false);
		expect(wrote).toEqual([["/docs/a"]]);
	});

	it("stops when Jev cannot be asked, instead of showing an unjudged question", async () => {
		const { instance, wrote } = hunt({ docs: [doc("a"), doc("b"), doc("c")], scores: {} });
		const first = await instance.round(false);
		expect(first).toEqual({ demo: null, exhausted: true });
		await instance.round(false);
		expect(wrote).toHaveLength(1);
	});

	it("gives a document back to the next round when the model call failed", async () => {
		let calls = 0;
		const { instance } = hunt({
			docs: [doc("a")],
			scores: { "q:a": 0.95 },
			write: async (given) => {
				calls += 1;
				if (calls === 1) throw new Error("timeout");
				return given.map((candidate, index) => ({ doc: index + 1, question: `q:${candidate.sourcePath.split("/").pop()}` }));
			},
		});
		expect((await instance.round(false)).demo).toBeNull();
		expect((await instance.round(false)).demo?.question).toBe("q:a");
	});

	it("stops asking a model that keeps failing", async () => {
		let calls = 0;
		const { instance } = hunt({
			docs: [doc("a")],
			scores: {},
			write: async () => {
				calls += 1;
				throw new Error("no credential");
			},
		});
		for (let round = 0; round < 5; round += 1) await instance.round(true);
		expect(calls).toBe(2);
	});

	it("shows the model no more documents than the cap", async () => {
		const { instance, wrote } = hunt({ docs: [doc("a"), doc("b"), doc("c"), doc("d")], scores: {}, maxDocs: 3, judge: async (candidates) => candidates.map(() => 0.1) });
		for (let round = 0; round < 4; round += 1) await instance.round(true);
		expect(wrote.flat()).toHaveLength(3);
	});
});

describe("readNoulScore", () => {
	it("reads the probability and rejects any other shape", () => {
		expect(readNoulScore({ answers: { quality: { type: "noul", noul: 0.93, confidence: 0.4 } } })).toBe(0.93);
		expect(readNoulScore({ answers: { quality: { noul: 1.4 } } })).toBeNull();
		expect(readNoulScore({ answers: {} })).toBeNull();
		expect(readNoulScore("nope")).toBeNull();
	});
});

describe("createDemoQuestionJudge", () => {
	it("scores nothing and calls nobody without a Dazzi credential", async () => {
		let calls = 0;
		const judge = createDemoQuestionJudge({
			env: {},
			agentDir: "/nonexistent-agent-dir",
			fetchImpl: async () => {
				calls += 1;
				return new Response("{}");
			},
		});
		expect(await judge([{ question: "q", excerpt: "e" }])).toEqual([null]);
		expect(calls).toBe(0);
	});
});
