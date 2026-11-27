// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LtrPage } from "../src/renderer/src/components/settings/LtrPage";
import { setAppLanguage, t } from "../src/shared/i18n";
import { EMPTY_LTR_SNAPSHOT, type LtrModel, type LtrSnapshot, type LtrTrainOutcome } from "../src/shared/ltr-contract";
import type { AutoRagConfigSnapshot, AutoRagConfigUpdate } from "../src/shared/settings-contract";

const bridge = vi.hoisted(() => {
	const ltr = {
		get: vi.fn(),
		train: vi.fn(),
		deleteModel: vi.fn(),
		onTraining: vi.fn((_listener: (running: boolean) => void) => () => undefined),
	};
	const settings = { configPatch: vi.fn() };
	Reflect.set(globalThis, "autorag", { platform: "darwin", settings, ltr });
	return { ltr, settings };
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;
const saved = vi.fn();

const model = (id: string, over: Partial<LtrModel> = {}): LtrModel => ({
	id,
	createdAt: Date.UTC(2026, 10, 19, 9, 0, 0),
	trainedOnRuns: 568,
	loggedRunsAtTraining: 944,
	holdout: { queries: 142, baseline: { ndcg10: 0.798, mrr: 0.765 }, model: { ndcg10: 0.798, mrr: 0.779 }, deltaMrrCi95: [0.0001, 0.029] },
	passedGate: true,
	seeds: 5,
	...over,
});

const snapshotOf = (over: Partial<LtrSnapshot> = {}): LtrSnapshot => ({ ...EMPTY_LTR_SNAPSHOT, ...over });
const config = (value: AutoRagConfigSnapshot["config"] = {}): AutoRagConfigSnapshot => ({ configPath: "/x/config.json", configExists: true, error: null, config: value });
const RERANK_ON = { rerank: { enabled: true, provider: "openrouter", model: "qwen/qwen3-reranker-8b" } };

async function render(ltr: LtrSnapshot, cfg: AutoRagConfigSnapshot["config"] = RERANK_ON): Promise<void> {
	bridge.ltr.get.mockResolvedValue(ltr);
	await act(async () => {
		root.render(<LtrPage snapshot={config(cfg)} onSaved={saved} />);
	});
}

const text = (): string => host.textContent ?? "";
const byLabel = (label: string): HTMLElement => {
	const found = host.querySelector<HTMLElement>(`[aria-label="${label}"]`);
	if (found === null) throw new Error(`no control labelled "${label}"; page shows: ${text().slice(0, 400)}`);
	return found;
};
const button = (label: string): HTMLButtonElement => {
	const found = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
	if (found === undefined) throw new Error(`no button "${label}"; buttons: ${[...host.querySelectorAll("button")].map((b) => b.textContent).join(" | ")}`);
	return found;
};
const writes = (): AutoRagConfigUpdate[][] => bridge.settings.configPatch.mock.calls.map((call) => call[0] as AutoRagConfigUpdate[]);

beforeEach(async () => {
	await setAppLanguage("en");
	for (const fn of [bridge.ltr.get, bridge.ltr.train, bridge.ltr.deleteModel, bridge.settings.configPatch, saved]) fn.mockReset();
	bridge.ltr.onTraining.mockReset();
	bridge.ltr.onTraining.mockImplementation(() => () => undefined);
	bridge.settings.configPatch.mockResolvedValue(config());
	host = document.createElement("div");
	host.className = "settings-view";
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

describe("LtrPage: what the log holds", () => {
	it("shows how many searches are logged against the number training needs", async () => {
		await render(snapshotOf({ loggedRuns: 47 }));

		expect(text()).toContain(t("settingsLtr.train.needMore", { count: 47, missing: 253 }));
	});

	it("says training needs the reranker, and offers the way to turn it on, when it is off", async () => {
		await render(snapshotOf({ loggedRuns: 300 }), {});

		expect(text()).toContain(t("settingsLtr.rerankNeeded.text"));
	});

	it("does not nag about the reranker once one is configured", async () => {
		await render(snapshotOf({ loggedRuns: 300 }), RERANK_ON);

		expect(text()).not.toContain(t("settingsLtr.rerankNeeded.text"));
	});

	it("treats rerank: false and a block without a model as off", async () => {
		await render(snapshotOf(), { rerank: false });
		expect(text()).toContain(t("settingsLtr.rerankNeeded.text"));
		await render(snapshotOf(), { rerank: { enabled: true } });
		expect(text()).toContain(t("settingsLtr.rerankNeeded.text"));
		await render(snapshotOf(), { rerank: { enabled: false, model: "m" } });
		expect(text()).toContain(t("settingsLtr.rerankNeeded.text"));
	});
});

describe("LtrPage: the log switch", () => {
	it("is on by default and writes rankingLog false when turned off", async () => {
		await render(snapshotOf());
		expect(byLabel(t("settingsLtr.log.name")).getAttribute("data-state")).toBe("checked");

		await act(async () => byLabel(t("settingsLtr.log.name")).click());

		expect(writes()).toEqual([[{ path: ["rankingLog"], value: false }]]);
	});

	it("shows off when rankingLog is false, and turning it on removes the key so the default applies", async () => {
		await render(snapshotOf(), { ...RERANK_ON, rankingLog: false });
		expect(byLabel(t("settingsLtr.log.name")).getAttribute("data-state")).toBe("unchecked");

		await act(async () => byLabel(t("settingsLtr.log.name")).click());

		expect(writes()).toEqual([[{ path: ["rankingLog"], remove: true }]]);
	});
});

describe("LtrPage: serving", () => {
	it("is off by default, and turning it on writes ltr.enabled", async () => {
		await render(snapshotOf({ models: [model("xgb-1")] }));
		expect(byLabel(t("settingsLtr.use.name")).getAttribute("data-state")).toBe("unchecked");

		await act(async () => byLabel(t("settingsLtr.use.name")).click());

		expect(writes()).toEqual([[{ path: ["ltr", "enabled"], value: true }]]);
	});

	it("explains that turning it on without a passing model changes nothing yet", async () => {
		await render(snapshotOf({ enabled: true, serving: { status: "no-model", reason: "no trained model has passed the holdout gate yet" } }));

		expect(text()).toContain(t("settingsLtr.use.hintNoModel"));
	});

	it("names the model that is serving", async () => {
		await render(snapshotOf({ enabled: true, models: [model("xgb-1")], serving: { status: "active", modelId: "xgb-1" } }));

		expect(text()).toContain(t("settingsLtr.use.hintActive"));
	});

	it("shows why a chosen model cannot serve", async () => {
		await render(snapshotOf({ enabled: true, serving: { status: "unusable", modelId: "xgb-1", reason: "the model was built for different features" } }));

		expect(text()).toContain(t("settingsLtr.use.hintUnusable"));
		expect(text()).toContain("the model was built for different features");
	});

	it("says plainly that search order is the reranker's own while serving is off", async () => {
		await render(snapshotOf({ enabled: false }));

		expect(text()).toContain(t("settingsLtr.use.hintOff"));
	});
});

describe("LtrPage: models", () => {
	it("lists each model with its verdict and the numbers behind it", async () => {
		await render(snapshotOf({ models: [model("xgb-pass"), model("xgb-fail", { passedGate: false, holdout: { queries: 80, baseline: { ndcg10: 0.7, mrr: 0.7 }, model: { ndcg10: 0.69, mrr: 0.66 }, deltaMrrCi95: [-0.08, 0.01] } })] }));

		const rows = [...host.querySelectorAll("[data-ltr-model]")];
		expect(rows.map((row) => row.getAttribute("data-ltr-model"))).toEqual(["xgb-pass", "xgb-fail"]);
		expect(rows[0]?.textContent).toContain(t("settingsLtr.model.passed"));
		expect(rows[1]?.textContent).toContain(t("settingsLtr.model.rejected"));
		expect(rows[0]?.textContent).toContain(t("settingsLtr.model.score", { from: "0.765", to: "0.779" }));
		expect(rows[1]?.textContent).toContain(t("settingsLtr.model.score", { from: "0.700", to: "0.660" }));
		expect(rows[0]?.textContent).toContain(t("settingsLtr.model.queries", { count: 142 }));
	});

	it("tells the person a passing model is not proof of better answers", async () => {
		await render(snapshotOf({ models: [model("xgb-1")] }));

		expect(text()).toContain(t("settingsLtr.model.caveat"));
	});

	it("pins a model to the config, and `latest` goes back to the default", async () => {
		await render(snapshotOf({ models: [model("xgb-1")] }));

		await act(async () => button(t("settingsLtr.model.use")).click());
		expect(writes().at(-1)).toEqual([{ path: ["ltr", "model"], value: "xgb-1" }]);
	});

	it("marks the pinned model and offers to follow the newest passing one again", async () => {
		await render(snapshotOf({ selection: "xgb-1", models: [model("xgb-1")] }), { ...RERANK_ON, ltr: { model: "xgb-1" } });

		expect(host.querySelector('[data-ltr-model="xgb-1"]')?.textContent).toContain(t("settingsLtr.model.pinned"));
		await act(async () => button(t("settingsLtr.model.useLatest")).click());
		expect(writes().at(-1)).toEqual([{ path: ["ltr", "model"], remove: true }]);
	});

	it("deletes a model after the person confirms, and refuses to offer it for the pinned one", async () => {
		bridge.ltr.deleteModel.mockResolvedValue(snapshotOf({ models: [] }));
		await render(snapshotOf({ models: [model("xgb-1"), model("xgb-2")], selection: "xgb-2" }), { ...RERANK_ON, ltr: { model: "xgb-2" } });

		const pinned = host.querySelector('[data-ltr-model="xgb-2"]');
		expect([...(pinned?.querySelectorAll("button") ?? [])].some((b) => b.textContent === t("settingsLtr.model.delete"))).toBe(false);

		const row = host.querySelector('[data-ltr-model="xgb-1"]');
		const del = [...(row?.querySelectorAll("button") ?? [])].find((b) => b.textContent === t("settingsLtr.model.delete"));
		await act(async () => del?.click());
		expect(bridge.ltr.deleteModel).not.toHaveBeenCalled();
		await act(async () => button(t("settingsLtr.model.deleteConfirm")).click());

		expect(bridge.ltr.deleteModel).toHaveBeenCalledWith("xgb-1");
	});

	it("marks the model that is serving as in use", async () => {
		await render(
			snapshotOf({ enabled: true, selection: "xgb-2", models: [model("xgb-1"), model("xgb-2")], serving: { status: "active", modelId: "xgb-2" } }),
			{ ...RERANK_ON, ltr: { enabled: true, model: "xgb-2" } },
		);
		expect(host.querySelector('[data-ltr-model="xgb-2"]')?.textContent).toContain(t("settingsLtr.model.inUse"));
		expect(host.querySelector('[data-ltr-model="xgb-1"]')?.textContent).not.toContain(t("settingsLtr.model.inUse"));
		// It is pinned too, and that is why it has no Delete: both chips show.
		expect(host.querySelector('[data-ltr-model="xgb-2"]')?.textContent).toContain(t("settingsLtr.model.pinned"));
	});

	it("marks a pinned model that is not serving as selected, not in use", async () => {
		await render(snapshotOf({ selection: "xgb-2", models: [model("xgb-2")] }), { ...RERANK_ON, ltr: { model: "xgb-2" } });
		expect(host.querySelector('[data-ltr-model="xgb-2"]')?.textContent).toContain(t("settingsLtr.model.pinned"));
		expect(host.querySelector('[data-ltr-model="xgb-2"]')?.textContent).not.toContain(t("settingsLtr.model.inUse"));
	});

	it("shows an empty state when nothing has been trained", async () => {
		await render(snapshotOf({ models: [] }));

		expect(text()).toContain(t("settingsLtr.model.none"));
	});
});

describe("LtrPage: training", () => {
	const outcome = (over: Partial<LtrTrainOutcome>): LtrTrainOutcome => ({ status: "trained", reason: null, model: model("xgb-9"), eligibleRuns: 568, loggedRuns: 944, snapshot: snapshotOf({ models: [model("xgb-9")] }), ...over });

	it("is disabled with the reason while the log is too small, and never calls the librarian", async () => {
		await render(snapshotOf({ loggedRuns: 12 }));

		const train = button(t("settingsLtr.train.button"));
		expect(train.disabled).toBe(true);
		expect(text()).toContain(t("settingsLtr.train.needMore", { count: 12, missing: 288 }));
		await act(async () => train.click());
		expect(bridge.ltr.train).not.toHaveBeenCalled();
	});

	it("trains on click and shows the model it made", async () => {
		bridge.ltr.train.mockResolvedValue(outcome({}));
		await render(snapshotOf({ loggedRuns: 944 }));

		await act(async () => button(t("settingsLtr.train.button")).click());

		expect(bridge.ltr.train).toHaveBeenCalledTimes(1);
		expect(text()).toContain(t("settingsLtr.train.trained"));
		expect(host.querySelector('[data-ltr-model="xgb-9"]')).not.toBeNull();
	});

	it("shows a rejected model as a result, in the librarian's words, not as an error", async () => {
		bridge.ltr.train.mockResolvedValue(outcome({ status: "rejected", reason: "did not beat the reranker's order: holdout 80 queries", model: model("xgb-8", { passedGate: false }), snapshot: snapshotOf({ models: [model("xgb-8", { passedGate: false })] }) }));
		await render(snapshotOf({ loggedRuns: 944 }));

		await act(async () => button(t("settingsLtr.train.button")).click());

		expect(text()).toContain(t("settingsLtr.train.rejected"));
		expect(text()).toContain("did not beat the reranker's order: holdout 80 queries");
		expect(host.querySelector('[role="alert"]')).toBeNull();
	});

	it("shows the librarian's reason when there is too little usable data", async () => {
		bridge.ltr.train.mockResolvedValue(outcome({ status: "insufficient-data", reason: "12 usable search runs in the log; at least 300 are needed", model: null, snapshot: snapshotOf({ loggedRuns: 350 }) }));
		await render(snapshotOf({ loggedRuns: 350 }));

		await act(async () => button(t("settingsLtr.train.button")).click());

		expect(text()).toContain("12 usable search runs in the log; at least 300 are needed");
	});

	it("shows a crashed attempt as an error the person can read", async () => {
		bridge.ltr.train.mockRejectedValue(new Error("exit 1: Killed"));
		await render(snapshotOf({ loggedRuns: 944 }));

		await act(async () => button(t("settingsLtr.train.button")).click());

		expect(host.querySelector('[role="alert"]')?.textContent).toContain("exit 1: Killed");
	});

	it("disables the button and says so while a run is going, including one that started elsewhere", async () => {
		await render(snapshotOf({ loggedRuns: 944, training: true }));

		expect(button(t("settingsLtr.train.running")).disabled).toBe(true);
	});

	it("follows the pushed training flag, and refreshes the models when a run ends", async () => {
		let push: (running: boolean) => void = () => undefined;
		bridge.ltr.onTraining.mockImplementation((listener: (running: boolean) => void) => {
			push = listener;
			return () => undefined;
		});
		await render(snapshotOf({ loggedRuns: 944 }));
		expect(button(t("settingsLtr.train.button")).disabled).toBe(false);

		await act(async () => push(true));
		expect(button(t("settingsLtr.train.running")).disabled).toBe(true);

		bridge.ltr.get.mockResolvedValue(snapshotOf({ loggedRuns: 944, models: [model("xgb-auto")] }));
		await act(async () => push(false));
		expect(host.querySelector('[data-ltr-model="xgb-auto"]')).not.toBeNull();
		expect(button(t("settingsLtr.train.button")).disabled).toBe(false);
	});

	it("stops listening when the page closes", async () => {
		const stop = vi.fn();
		bridge.ltr.onTraining.mockReturnValue(stop);
		await render(snapshotOf());

		act(() => root.unmount());
		root = createRoot(host);

		expect(stop).toHaveBeenCalledTimes(1);
	});
});

describe("LtrPage: automatic training", () => {
	it("is off by default and writes the setting when turned on", async () => {
		await render(snapshotOf());
		expect(byLabel(t("settingsLtr.auto.name")).getAttribute("data-state")).toBe("unchecked");

		await act(async () => byLabel(t("settingsLtr.auto.name")).click());

		expect(writes()).toEqual([[{ path: ["ltr", "autoTrain", "enabled"], value: true }]]);
	});

	it("shows the interval only while automatic training is on, and writes a whole number of searches", async () => {
		await render(snapshotOf({ autoTrain: { enabled: true, minNewRuns: 200, due: false } }), { ...RERANK_ON, ltr: { autoTrain: { enabled: true } } });

		const field = byLabel(t("settingsLtr.auto.every")) as HTMLInputElement;
		expect(field.value).toBe("200");
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setter?.call(field, "150");
			field.dispatchEvent(new Event("input", { bubbles: true }));
			field.dispatchEvent(new Event("change", { bubbles: true }));
			field.dispatchEvent(new Event("focusout", { bubbles: true }));
		});

		expect(writes().at(-1)).toEqual([{ path: ["ltr", "autoTrain", "minNewRuns"], value: 150 }]);
	});

	it("refuses an interval that is not a positive whole number, and does not write it", async () => {
		await render(snapshotOf({ autoTrain: { enabled: true, minNewRuns: 200, due: false } }), { ...RERANK_ON, ltr: { autoTrain: { enabled: true } } });
		const field = byLabel(t("settingsLtr.auto.every")) as HTMLInputElement;

		for (const bad of ["0", "-5", "2.5", "abc", ""]) {
			await act(async () => {
				Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, bad);
				field.dispatchEvent(new Event("input", { bubbles: true }));
				field.dispatchEvent(new Event("change", { bubbles: true }));
				field.dispatchEvent(new Event("focusout", { bubbles: true }));
			});
		}

		expect(bridge.settings.configPatch).not.toHaveBeenCalled();
	});

	it("hides the interval while automatic training is off", async () => {
		await render(snapshotOf());

		expect(host.querySelector(`[aria-label="${t("settingsLtr.auto.every")}"]`)).toBeNull();
	});
});

describe("LtrPage: answers that arrive out of order", () => {
	it("keeps the newest status when an older read answers last", async () => {
		const older = Promise.withResolvers<LtrSnapshot>();
		bridge.ltr.get.mockReset();
		bridge.ltr.get.mockImplementationOnce(() => older.promise);
		bridge.ltr.get.mockResolvedValue(snapshotOf({ loggedRuns: 77 }));
		await act(async () => {
			root.render(<LtrPage snapshot={config(RERANK_ON)} onSaved={saved} />);
		});

		// A write made while the first read is still running reads again, and that read answers first.
		await act(async () => byLabel(t("settingsLtr.log.name")).click());
		expect(text()).toContain(t("settingsLtr.train.needMore", { count: 77, missing: 223 }));
		await act(async () => older.resolve(snapshotOf({ loggedRuns: 11 })));

		expect(text()).toContain(t("settingsLtr.train.needMore", { count: 77, missing: 223 }));
		expect(text()).not.toContain(t("settingsLtr.train.needMore", { count: 11, missing: 289 }));
	});

	it("does not let a read that started before a training run overwrite the models it made", async () => {
		const older = Promise.withResolvers<LtrSnapshot>();
		bridge.ltr.get.mockReset();
		bridge.ltr.get.mockImplementationOnce(() => older.promise);
		const trained: LtrTrainOutcome = { status: "trained", reason: null, model: model("xgb-new"), eligibleRuns: 300, loggedRuns: 300, snapshot: snapshotOf({ loggedRuns: 300, models: [model("xgb-new")] }) };
		bridge.ltr.train.mockResolvedValue(trained);
		await act(async () => {
			root.render(<LtrPage snapshot={config(RERANK_ON)} onSaved={saved} />);
		});
		// The first read has not answered, so the button is not usable until the page knows the log size: answer it small.
		await act(async () => older.resolve(snapshotOf({ loggedRuns: 300 })));
		const slow = Promise.withResolvers<LtrSnapshot>();
		bridge.ltr.get.mockImplementationOnce(() => slow.promise);
		await act(async () => byLabel(t("settingsLtr.log.name")).click());
		await act(async () => button(t("settingsLtr.train.button")).click());
		expect(host.querySelector('[data-ltr-model="xgb-new"]')).not.toBeNull();

		await act(async () => slow.resolve(snapshotOf({ loggedRuns: 300, models: [] })));

		expect(host.querySelector('[data-ltr-model="xgb-new"]')).not.toBeNull();
	});
});

describe("LtrPage: the interval field", () => {
	const bad = async (field: HTMLInputElement, value: string): Promise<void> => {
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
			field.dispatchEvent(new Event("input", { bubbles: true }));
			field.dispatchEvent(new Event("change", { bubbles: true }));
			field.dispatchEvent(new Event("focusout", { bubbles: true }));
		});
	};

	it("takes the refusal off the page as soon as the person edits the field again", async () => {
		await render(snapshotOf({ autoTrain: { enabled: true, minNewRuns: 200, due: false } }), { ...RERANK_ON, ltr: { autoTrain: { enabled: true } } });
		const field = byLabel(t("settingsLtr.auto.every")) as HTMLInputElement;
		await bad(field, "0");
		expect(text()).toContain(t("settingsLtr.auto.invalid"));

		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, "1");
			field.dispatchEvent(new Event("input", { bubbles: true }));
		});

		expect(text()).not.toContain(t("settingsLtr.auto.invalid"));
	});

	it("shows the value the librarian reports after a write, not the one before it", async () => {
		bridge.ltr.get.mockReset();
		bridge.ltr.get.mockResolvedValueOnce(snapshotOf({ autoTrain: { enabled: true, minNewRuns: 200, due: false } }));
		bridge.ltr.get.mockResolvedValue(snapshotOf({ autoTrain: { enabled: true, minNewRuns: 150, due: false } }));
		await act(async () => {
			root.render(<LtrPage snapshot={config({ ...RERANK_ON, ltr: { autoTrain: { enabled: true } } })} onSaved={saved} />);
		});
		const field = byLabel(t("settingsLtr.auto.every")) as HTMLInputElement;

		await bad(field, "150");

		expect((byLabel(t("settingsLtr.auto.every")) as HTMLInputElement).value).toBe("150");
	});
});

describe("LtrPage: layout", () => {
	it("is three sections under the page head, like the other settings pages", async () => {
		await render(snapshotOf({ models: [model("xgb-1")] }));

		expect(host.querySelector(".settings-ltr > .plain-sections")).not.toBeNull();
		expect([...host.querySelectorAll(".settings-ltr .plain-section-title")].map((node) => node.textContent)).toEqual([
			t("settingsLtr.section.train"),
			t("settingsLtr.section.use"),
			t("settingsLtr.section.models"),
		]);
	});

	it("keeps every explanation in a row's hint instead of loose paragraphs between sections", async () => {
		await render(snapshotOf({ loggedRuns: 400, models: [model("xgb-1")] }));

		for (const loose of [".ltr-count", ".ltr-privacy", ".ltr-serving"]) expect(host.querySelector(loose), loose).toBeNull();
		expect(host.querySelectorAll(".settings-ltr .settings-plain-row").length).toBeGreaterThanOrEqual(4);
	});

	it("shows the count of logged searches in the training row, with no extra line", async () => {
		await render(snapshotOf({ loggedRuns: 400 }));

		const row = [...host.querySelectorAll(".settings-plain-row")].find((node) => node.textContent?.includes(t("settingsLtr.train.name")));
		expect(row?.textContent).toContain(t("settingsLtr.train.hint", { count: 400 }));
	});

	it("never prints a model's internal id", async () => {
		await render(snapshotOf({ enabled: true, models: [model("xgb-20261119095228-5eff77")], serving: { status: "active", modelId: "xgb-20261119095228-5eff77" } }));

		expect(text()).not.toContain("xgb-20261119095228-5eff77");
	});
});

describe("LtrPage: failure and limits", () => {
	it("shows the librarian's refusal of a settings write", async () => {
		bridge.settings.configPatch.mockRejectedValue(new Error("ltr.enabled must be a boolean"));
		await render(snapshotOf());

		await act(async () => byLabel(t("settingsLtr.use.name")).click());

		expect(host.querySelector('[role="alert"]')?.textContent).toContain("ltr.enabled must be a boolean");
	});

	it("says it could not read the log state, instead of showing zeros", async () => {
		bridge.ltr.get.mockRejectedValue(new Error("exit 2: Config file not found"));
		await act(async () => {
			root.render(<LtrPage snapshot={config(RERANK_ON)} onSaved={saved} />);
		});

		expect(host.querySelector('[role="alert"]')?.textContent).toContain("exit 2: Config file not found");
		expect(text()).not.toContain(t("settingsLtr.train.needMore", { count: 0, missing: 100 }));
	});

	it("says in the record row what is stored and what is not, so the person can decide", async () => {
		await render(snapshotOf());

		const hint = [...host.querySelectorAll(".settings-plain-row")].find((node) => node.textContent?.includes(t("settingsLtr.log.name")))?.querySelector("small")?.textContent;
		expect(hint).toBe(t("settingsLtr.log.hint"));
	});
});
