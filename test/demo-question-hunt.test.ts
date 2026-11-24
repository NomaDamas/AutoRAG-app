import { describe, expect, it } from "vitest";
import { createDemoHunt, type DemoDoc, type DemoHuntDeps } from "../src/main/demo-question-hunt";
import { createDemoQuestionJudge, passesDemoBar, readVerdict, type DemoQuestionVerdict } from "../src/main/demo-question-judge";

const doc = (name: string): DemoDoc => ({ sourcePath: `/docs/${name}`, realSourcePath: `/docs/${name}`, excerpt: `excerpt of ${name}` });
const nameOf = (question: string): string => question.slice(2);

/** A score of one number is a verdict whose `private` is comfortably over the bar. */
type Scores = Readonly<Record<string, number | DemoQuestionVerdict | null>>;

function hunt(overrides: Partial<DemoHuntDeps> & { readonly docs: readonly DemoDoc[]; readonly scores: Scores }) {
	const { docs, scores, ...rest } = overrides;
	const wrote: string[][] = [];
	const answered: string[] = [];
	let clock = 0;
	const deps: DemoHuntDeps = {
		collect: (seen) => docs.filter((candidate) => !seen.has(candidate.sourcePath)),
		write: async (given) => {
			wrote.push(given.map((candidate) => candidate.sourcePath));
			return given.map((candidate, index) => ({ doc: index + 1, question: `q:${candidate.sourcePath.slice("/docs/".length)}` }));
		},
		retrieve: async (query) => [{ source: `/docs/${nameOf(query)}` }],
		judge: async (candidates) =>
			candidates.map((candidate) => {
				const score = scores[candidate.question];
				if (score === undefined || score === null) return null;
				return typeof score === "number" ? { quality: score, private: 0.9 } : score;
			}),
		realpath: (path) => path,
		// By default the real answer cites the question's own document.
		answer: async (question) => {
			answered.push(question);
			return [`/docs/${nameOf(question)}`];
		},
		maxDocs: 10,
		batchSize: 2,
		now: () => (clock += 1),
		...rest,
	};
	return { instance: createDemoHunt(deps), wrote, answered };
}

describe("createDemoHunt", () => {
	it("takes no question below the bar and keeps looking at new documents until one clears it", async () => {
		const { instance, wrote } = hunt({ docs: [doc("a"), doc("b"), doc("c"), doc("d")], scores: { "q:a": 0.8, "q:b": 0.89, "q:c": 0.95, "q:d": 0.92 } });
		expect((await instance.round(false)).demo).toBeNull();
		const second = await instance.round(false);
		expect(second.demo?.question).toBe("q:c");
		expect(wrote).toEqual([["/docs/a", "/docs/b"], ["/docs/c", "/docs/d"]]);
	});

	it("picks the highest quality of a round, not the first over the bar", async () => {
		const { instance } = hunt({ docs: [doc("a"), doc("b")], scores: { "q:a": 0.91, "q:b": 0.97 } });
		expect((await instance.round(false)).demo?.question).toBe("q:b");
	});

	it("refuses a question the web or general knowledge could answer, however good it reads", async () => {
		const { instance, answered } = hunt({
			docs: [doc("a"), doc("b")],
			scores: { "q:a": { quality: 0.99, private: 0.3 }, "q:b": { quality: 0.92, private: 0.8 } },
		});
		const round = await instance.round(false);
		expect(round.demo?.question).toBe("q:b");
		expect(answered).toEqual(["q:b"]);
	});

	it("holds a question whose document is not searchable yet and judges it once it is", async () => {
		let indexed = false;
		const { instance } = hunt({
			docs: [doc("a")],
			scores: { "q:a": 0.95 },
			retrieve: async (query) => (indexed ? [{ source: `/docs/${nameOf(query)}` }] : []),
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
				return given.map((candidate, index) => ({ doc: index + 1, question: `q:${candidate.sourcePath.slice(6)}` }));
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
		const { instance, wrote } = hunt({
			docs: [doc("a"), doc("b"), doc("c"), doc("d")],
			scores: {},
			maxDocs: 3,
			judge: async (candidates) => candidates.map(() => ({ quality: 0.1, private: 0.1 })),
		});
		for (let round = 0; round < 4; round += 1) await instance.round(true);
		expect(wrote.flat()).toHaveLength(3);
	});
});

describe("createDemoHunt answer check", () => {
	it("offers a question only after the real answer to it cited its own document", async () => {
		const { instance, answered } = hunt({ docs: [doc("a")], scores: { "q:a": 0.95 } });
		const round = await instance.round(false);
		expect(answered).toEqual(["q:a"]);
		expect(round.demo?.question).toBe("q:a");
	});

	it("skips a question whose answer cites some other document, and tries the next best", async () => {
		const { instance, answered } = hunt({
			docs: [doc("a"), doc("b")],
			scores: { "q:a": 0.97, "q:b": 0.92 },
			answer: async (question) => (question === "q:a" ? ["/docs/other"] : [`/docs/${nameOf(question)}`]),
		});
		const round = await instance.round(false);
		expect(round.demo?.question).toBe("q:b");
		expect(answered).toEqual([]);
	});

	it("skips a question that got no answer at all, or whose answer run failed", async () => {
		const { instance } = hunt({
			docs: [doc("a"), doc("b"), doc("c")],
			scores: { "q:a": 0.99, "q:b": 0.97, "q:c": 0.92 },
			batchSize: 3,
			answer: async (question) => {
				if (question === "q:a") return null;
				if (question === "q:b") throw new Error("model request failed");
				return [`/docs/${nameOf(question)}`];
			},
		});
		expect((await instance.round(false)).demo?.question).toBe("q:c");
	});

	it("takes no question when every real answer failed", async () => {
		const { instance } = hunt({ docs: [doc("a")], scores: { "q:a": 0.99 }, answer: async () => null });
		const round = await instance.round(false);
		expect(round.demo).toBeNull();
	});

	it("answers the best candidate first and stops at the first that holds", async () => {
		const { instance, answered } = hunt({ docs: [doc("a"), doc("b"), doc("c")], batchSize: 3, scores: { "q:a": 0.91, "q:b": 0.97, "q:c": 0.94 } });
		const round = await instance.round(false);
		expect(round.demo?.question).toBe("q:b");
		expect(answered).toEqual(["q:b"]);
	});

	it("does not run the real answer for a question Jev refused", async () => {
		const { instance, answered } = hunt({ docs: [doc("a")], scores: { "q:a": 0.5 } });
		await instance.round(false);
		expect(answered).toEqual([]);
	});
});

describe("passesDemoBar", () => {
	it("needs both a high quality and a private answer", () => {
		expect(passesDemoBar({ quality: 0.9, private: 0.7 })).toBe(true);
		expect(passesDemoBar({ quality: 0.89, private: 0.99 })).toBe(false);
		expect(passesDemoBar({ quality: 0.99, private: 0.69 })).toBe(false);
	});
});

describe("readVerdict", () => {
	it("reads both probabilities and rejects any other shape", () => {
		expect(readVerdict({ answers: { quality: { type: "noul", noul: 0.93, confidence: 0.4 }, private: { type: "noul", noul: 0.12 } } })).toEqual({ quality: 0.93, private: 0.12 });
		expect(readVerdict({ answers: { quality: { noul: 1.4 }, private: { noul: 0.5 } } })).toBeNull();
		expect(readVerdict({ answers: { quality: { noul: 0.5 } } })).toBeNull();
		expect(readVerdict("nope")).toBeNull();
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
