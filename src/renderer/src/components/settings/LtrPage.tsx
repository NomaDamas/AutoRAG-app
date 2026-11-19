/**
 * Settings → 검색 순위 학습 (learning to rank).
 *
 * The librarian logs every search's candidates and outcome, can fit a ranking model on that log, and reorders the
 * reranker's results with it when asked. Three sections, like the other pages: 학습 (record, train, retrain on its own),
 * 적용 (use the trained model), 학습된 모델 (each with its verdict, pin and delete). Every explanation is the hint of the
 * row it belongs to; nothing floats between sections.
 *
 * The switches are the shared config's `rankingLog`, `ltr.enabled`, `ltr.model` and `ltr.autoTrain`, written through
 * `configPatch` like every other setting. What the config cannot say (the log size, the models, a run in flight) comes
 * from `window.autorag.ltr`; training itself runs in a child process (see `ltr-service`).
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { AutoRagConfigSnapshot } from "../../../../shared/settings-contract";
import type { LtrModel, LtrSnapshot, LtrTrainOutcome } from "../../../../shared/ltr-contract";
import { Switch } from "../primitives/Switch";
import { Note, PlainDivider, PlainRow, PlainSection, SettingsPageHead } from "./SettingsKit";
import { asRecord, errorText, getAt, stringOf, useConfigWriter } from "./configSupport";

const ltrBridge = window.autorag.ltr;

/** Reranking is on only when a model is named and the block is not switched off (the librarian's own rule). */
function rerankIsOn(config: AutoRagConfigSnapshot["config"]): boolean {
	const raw = getAt(config, ["rerank"]);
	if (raw === false || raw === undefined || raw === true) return false;
	const block = asRecord(raw);
	return block !== null && block.enabled !== false && stringOf(block.model).length > 0;
}

/** 0.7651 → "0.765"; the three decimals the librarian's own reasons use. */
const score = (value: number): string => value.toFixed(3);

interface TrainResult {
	readonly kind: "trained" | "rejected" | "insufficient" | "failed";
	readonly reason: string | null;
}

function trainResultOf(outcome: LtrTrainOutcome): TrainResult {
	switch (outcome.status) {
		case "trained":
			return { kind: "trained", reason: null };
		case "rejected":
			return { kind: "rejected", reason: outcome.reason };
		case "insufficient-data":
			return { kind: "insufficient", reason: outcome.reason };
		default:
			return { kind: "failed", reason: outcome.reason };
	}
}

function ModelRow({
	model,
	inUse,
	pinned,
	onUse,
	onDelete,
	busy,
}: {
	readonly model: LtrModel;
	/** The model a search would use right now. */
	readonly inUse: boolean;
	/** The config names this model. */
	readonly pinned: boolean;
	readonly onUse: () => void;
	readonly onDelete: () => void;
	readonly busy: boolean;
}): ReactElement {
	const { t, i18n } = useTranslation();
	const [asking, setAsking] = useState(false);
	// The id is an internal name: the person tells models apart by when each was made and how it scored.
	const made = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(model.createdAt);
	return (
		<div className="ltr-model" data-ltr-model={model.id} data-passed={model.passedGate ? "true" : "false"}>
			<div className="ltr-model-main">
				<div className="ltr-model-title">
					<span className="ltr-model-date">{made}</span>
					<span className={model.passedGate ? "ltr-verdict is-passed" : "ltr-verdict is-rejected"}>{model.passedGate ? t("settingsLtr.model.passed") : t("settingsLtr.model.rejected")}</span>
					{inUse ? <span className="ltr-verdict is-use">{t("settingsLtr.model.inUse")}</span> : null}
					{pinned ? <span className="ltr-verdict is-pinned">{t("settingsLtr.model.pinned")}</span> : null}
				</div>
				<small className="ltr-model-meta">
					{t("settingsLtr.model.score", { from: score(model.holdout.baseline.mrr), to: score(model.holdout.model.mrr) })} · {t("settingsLtr.model.queries", { count: model.holdout.queries })}
				</small>
			</div>
			<div className="ltr-model-actions">
				{asking ? (
					<>
						<span className="ltr-ask">{t("settingsLtr.model.deleteAsk")}</span>
						<button type="button" className="linear-btn is-danger" disabled={busy} onClick={() => { setAsking(false); onDelete(); }}>{t("settingsLtr.model.deleteConfirm")}</button>
						<button type="button" className="linear-btn settings-btn-quiet" onClick={() => setAsking(false)}>{t("settingsLtr.model.cancel")}</button>
					</>
				) : (
					<>
						{!pinned && model.passedGate ? <button type="button" className="linear-btn settings-btn-quiet" disabled={busy} onClick={onUse}>{t("settingsLtr.model.use")}</button> : null}
						{!pinned ? <button type="button" className="linear-btn settings-btn-quiet" disabled={busy} onClick={() => setAsking(true)}>{t("settingsLtr.model.delete")}</button> : null}
					</>
				)}
			</div>
		</div>
	);
}

export function LtrPage({
	snapshot,
	onSaved,
	onOpenAi,
}: {
	readonly snapshot: AutoRagConfigSnapshot;
	readonly onSaved: (next: AutoRagConfigSnapshot) => void;
	/** Settings → AI 모델, where the reranker is turned on. */
	readonly onOpenAi?: () => void;
}): ReactElement {
	const { t } = useTranslation();
	const { run, error: writeError } = useConfigWriter(onSaved);
	const [ltr, setLtr] = useState<LtrSnapshot | null>(null);
	const [readError, setReadError] = useState<string | null>(null);
	const [training, setTraining] = useState(false);
	const [result, setResult] = useState<TrainResult | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [interval, setIntervalText] = useState<string | null>(null);
	const [intervalProblem, setIntervalProblem] = useState(false);
	const mounted = useRef(true);

	/** Counts the answers applied so far; a read that answers after a newer one was applied is dropped. */
	const newest = useRef(0);
	const reload = useCallback(async (): Promise<void> => {
		const mine = (newest.current += 1);
		try {
			const next = await ltrBridge.get();
			if (!mounted.current || mine !== newest.current) return;
			setLtr(next);
			setTraining(next.training);
			setReadError(null);
		} catch (cause) {
			if (mounted.current && mine === newest.current) setReadError(errorText(cause));
		}
	}, []);

	useEffect(() => {
		mounted.current = true;
		void reload();
		const stop = ltrBridge.onTraining((running) => {
			setTraining(running);
			// A run that ends elsewhere (automatic training after a search) leaves new models behind.
			if (!running) void reload();
		});
		return () => {
			mounted.current = false;
			stop();
		};
	}, [reload]);

	// A write changes what the librarian reports (serving, the pinned model, whether training is due).
	const write = useCallback(
		async (updates: Parameters<typeof run>[0]): Promise<void> => {
			await run(updates);
			await reload();
		},
		[run, reload],
	);

	async function train(): Promise<void> {
		setActionError(null);
		setResult(null);
		setTraining(true);
		try {
			const outcome = await ltrBridge.train();
			if (!mounted.current) return;
			// A read that started before this run ended describes the log without the model it made.
			newest.current += 1;
			setLtr(outcome.snapshot);
			setResult(trainResultOf(outcome));
		} catch (cause) {
			if (mounted.current) setActionError(errorText(cause));
		} finally {
			if (mounted.current) setTraining(false);
		}
	}

	async function deleteModel(id: string): Promise<void> {
		setActionError(null);
		try {
			const next = await ltrBridge.deleteModel(id);
			if (mounted.current) {
				newest.current += 1;
				setLtr(next);
			}
		} catch (cause) {
			if (mounted.current) setActionError(errorText(cause));
		}
	}

	async function commitInterval(): Promise<void> {
		if (interval === null) return;
		const value = Number(interval);
		if (interval.trim().length === 0 || !Number.isInteger(value) || value < 1) {
			setIntervalText(null);
			setIntervalProblem(true);
			return;
		}
		setIntervalProblem(false);
		// The typed number stays on screen until the librarian reports it back, so the field never flashes the old value.
		await write([{ path: ["ltr", "autoTrain", "minNewRuns"], value }]);
		if (mounted.current) setIntervalText(null);
	}

	const rankingLog = getAt(snapshot.config, ["rankingLog"]) !== false;
	const ltrBlock = asRecord(getAt(snapshot.config, ["ltr"]));
	const pinnedModel = stringOf(ltrBlock?.model);
	const rerankOn = rerankIsOn(snapshot.config);
	const error = writeError ?? actionError;

	const logged = ltr?.loggedRuns ?? 0;
	const needed = ltr?.minTrainingRuns ?? 100;
	const missing = Math.max(0, needed - logged);
	const canTrain = ltr !== null && missing === 0 && !training;
	const serving = ltr?.serving;
	const servingId = serving?.status === "active" ? serving.modelId : null;
	const useOn = ltr?.enabled ?? ltrBlock?.enabled === true;
	const useHint =
		serving === undefined || serving.status === "disabled"
			? useOn
				? t("settingsLtr.use.hint")
				: t("settingsLtr.use.hintOff")
			: serving.status === "no-model"
				? t("settingsLtr.use.hintNoModel")
				: serving.status === "active"
					? t("settingsLtr.use.hintActive")
					: t("settingsLtr.use.hintUnusable");

	return (
		<div className="settings-ltr">
			<SettingsPageHead title={t("settingsLtr.title")} description={t("settingsLtr.description")} />

			{!rerankOn ? (
				<Note>
					{t("settingsLtr.rerankNeeded.text")}
					{onOpenAi !== undefined ? (
						<>
							{" "}
							<button type="button" className="ltr-link" onClick={onOpenAi}>{t("settingsLtr.rerankNeeded.open")}</button>
						</>
					) : null}
				</Note>
			) : null}

			{readError !== null ? <div className="settings-error" role="alert">{t("settingsLtr.error.read", { reason: readError })}</div> : null}
			{error !== null ? <div className="settings-error" role="alert">{error}</div> : null}

			<div className="plain-sections">
				<PlainSection title={t("settingsLtr.section.train")}>
					<PlainRow name={t("settingsLtr.log.name")} hint={t("settingsLtr.log.hint")}>
						<Switch
							checked={rankingLog}
							ariaLabel={t("settingsLtr.log.name")}
							onChange={() => void write([rankingLog ? { path: ["rankingLog"], value: false } : { path: ["rankingLog"], remove: true }])}
						/>
					</PlainRow>
					<PlainRow name={t("settingsLtr.train.name")} hint={ltr === null ? "" : missing > 0 ? t("settingsLtr.train.needMore", { count: logged, missing }) : t("settingsLtr.train.hint", { count: logged })}>
						<button type="button" className="linear-btn settings-btn-primary" disabled={!canTrain} onClick={() => void train()}>
							{training ? t("settingsLtr.train.running") : t("settingsLtr.train.button")}
						</button>
					</PlainRow>
					{result !== null ? (
						<p className={`ltr-result is-${result.kind}`} role="status">
							{result.kind === "trained" ? t("settingsLtr.train.trained") : null}
							{result.kind === "rejected" ? t("settingsLtr.train.rejected") : null}
							{result.kind === "insufficient" ? t("settingsLtr.train.insufficient") : null}
							{result.kind === "failed" ? t("settingsLtr.train.failed") : null}
							{result.reason !== null ? <span className="ltr-reason">{result.reason}</span> : null}
						</p>
					) : null}
					<PlainRow name={t("settingsLtr.auto.name")} hint={t("settingsLtr.auto.hint")}>
						<Switch
							checked={ltr?.autoTrain.enabled ?? false}
							ariaLabel={t("settingsLtr.auto.name")}
							onChange={() => void write([{ path: ["ltr", "autoTrain", "enabled"], value: !(ltr?.autoTrain.enabled ?? false) }])}
						/>
					</PlainRow>
					{ltr?.autoTrain.enabled === true ? (
						<PlainRow name={t("settingsLtr.auto.every")} hint={t("settingsLtr.auto.everyHint")}>
							<input
								type="text"
								inputMode="numeric"
								className="settings-select-compact ltr-number"
								aria-label={t("settingsLtr.auto.every")}
								value={interval ?? String(ltr.autoTrain.minNewRuns)}
								onChange={(event) => {
									setIntervalProblem(false);
									setIntervalText(event.target.value);
								}}
								onBlur={() => void commitInterval()}
								onKeyDown={(event) => {
									if (event.key === "Enter") event.currentTarget.blur();
								}}
							/>
							<span className="ltr-unit">{t("settingsLtr.auto.unit")}</span>
						</PlainRow>
					) : null}
					{intervalProblem ? <div className="settings-error" role="alert">{t("settingsLtr.auto.invalid")}</div> : null}
				</PlainSection>

				<PlainDivider />

				<PlainSection title={t("settingsLtr.section.use")}>
					<PlainRow name={t("settingsLtr.use.name")} hint={useHint}>
						<Switch
							checked={useOn}
							ariaLabel={t("settingsLtr.use.name")}
							onChange={() => void write([{ path: ["ltr", "enabled"], value: !useOn }])}
						/>
					</PlainRow>
					{serving?.status === "unusable" ? <p className="ltr-reason">{serving.reason}</p> : null}
				</PlainSection>

				<PlainDivider />

				<PlainSection title={t("settingsLtr.section.models")}>
					{ltr !== null && ltr.models.length === 0 ? <p className="ltr-empty">{t("settingsLtr.model.none")}</p> : null}
					{ltr?.models.map((model) => (
						<ModelRow
							key={model.id}
							model={model}
							inUse={servingId === model.id}
							pinned={pinnedModel === model.id}
							busy={training}
							onUse={() => void write([{ path: ["ltr", "model"], value: model.id }])}
							onDelete={() => void deleteModel(model.id)}
						/>
					))}
					{pinnedModel.length > 0 && pinnedModel !== "latest" ? (
						<button type="button" className="ltr-link" onClick={() => void write([{ path: ["ltr", "model"], remove: true }])}>{t("settingsLtr.model.useLatest")}</button>
					) : null}
					{ltr !== null && ltr.models.length > 0 ? <p className="ltr-caveat">{t("settingsLtr.model.caveat")}</p> : null}
				</PlainSection>
			</div>
		</div>
	);
}
