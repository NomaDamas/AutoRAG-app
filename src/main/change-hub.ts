/**
 * One serial FIFO queue owns filesystem changes and derived-layer publications.
 *
 * Register layers before the first operation; duplicate ids throw. Ingests
 * waiting for a running job merge into exactly one next batch by concatenating
 * directories in arrival order. Publish/current/resync calls are queue barriers
 * so coalescing cannot move later events ahead of those operations. A batch
 * window (default 0ms) can coalesce events before that batch starts.
 *
 * A batch visits layers in registration order, awaiting each applyChanges
 * raced against the per-layer timeout (default 750ms). Changed layers increment
 * their own version and include a fresh snapshot. Unchanged layers publish
 * nothing but are reconciled. A timed-out layer is omitted from publications
 * and reconciled, logs "[change-hub] layer <id> exceeded <ms>ms", and queues
 * publish(id) on eventual successful completion, even when it returned false.
 * Rejections (including late rejections) are logged with the layer id and the
 * original error and do not queue publish. Other layers and later messages
 * proceed despite a hung layer.
 * Only then send one message containing the dirs, changed publications, and
 * ids whose applyChanges resolved in time. seq starts at 0 and increases by
 * exactly 1 for each sent message: layers-before-view and total order.
 *
 * publish(id) queues one fresh snapshot, increments that layer's version, and
 * sends dirs: []. Under A3 it includes id in reconciled only when no applyChanges
 * call for that layer is still outstanding when the message is sent. A timed-out
 * apply is outstanding until it settles: scan publications cannot prematurely
 * reconcile it, while its late-completion publication can reconcile it once
 * all outstanding applies have settled.
 *
 * current() runs on the queue and returns every layer's latest publication;
 * a layer with no successful publication is absent. resync() runs on the same
 * queue, awaits each optional resync once with the same timeout, increments
 * only changed versions, and returns LiveResync with the last sent seq and
 * every latest publication. Its reconciled ids are precisely layers whose
 * resync resolved in time; layers without resync or with timeout/rejection
 * remain unreconciled and retain their last publication. A late resync that
 * resolves true queues publish(id), so its changed snapshot is eventually sent
 * as dirs: [] with reconciled: [id]; a late false or rejection sends nothing.
 * resync itself sends no LiveMessage. Snapshot reads are already-verified
 * publications, not unbounded reconciliation commands.
 *
 * send and timers are injected; no Electron imports or dupey knowledge.
 */

import type {
	FsDirChange,
	LayerPublication,
	LiveMessage,
	LiveResync,
} from "../shared/live-contract";

type TimerHandle = ReturnType<typeof setTimeout> | number;

export interface DerivedLayer<T = unknown> {
	readonly id: string;
	/** Current published data (already verified). */
	snapshot(): Promise<T>;
	/** Bounded reconciliation (in-memory work + lstat). True when published data changed. */
	applyChanges(dirs: readonly FsDirChange[]): Promise<boolean>;
	/** Optional full re-derivation against disk. True when published data changed. */
	resync?(): Promise<boolean>;
}

export interface ChangeHub {
	register(layer: DerivedLayer): void;
	ingest(batch: FsDirChange): void;
	publish(layerId: string): void;
	current(): Promise<{ seq: number; layers: readonly LayerPublication[] }>;
	resync(): Promise<LiveResync>;
}

interface ChangeHubDeps {
	readonly send: (message: LiveMessage) => void;
	readonly layerTimeoutMs?: number;
	readonly batchWindowMs?: number;
	readonly setTimer?: (handler: () => void, ms: number) => TimerHandle;
	readonly clearTimer?: (handle: TimerHandle) => void;
}

/** Mutable registry state belongs exclusively to the hub queue. */
interface RegisteredLayer {
	readonly layer: DerivedLayer;
	version: number;
	publication: LayerPublication | undefined;
	outstandingApplies: number;
}

export function createChangeHub(deps: ChangeHubDeps): ChangeHub {
	const layerTimeoutMs = deps.layerTimeoutMs ?? 750;
	const batchWindowMs = deps.batchWindowMs ?? 0;
	const setTimer = deps.setTimer ?? ((handler: () => void, ms: number) => setTimeout(handler, ms));
	const clearTimer = deps.clearTimer ?? ((handle: TimerHandle) => {
		if (typeof handle === "number") clearTimeout(handle);
		else clearTimeout(handle);
	});
	const registry = new Map<string, RegisteredLayer>();
	let queue: Promise<unknown> = Promise.resolve();
	let pendingDirs: FsDirChange[] | undefined;
	let started = false;
	let seq = 0;

	function serialize<T>(work: () => Promise<T>): Promise<T> {
		started = true;
		const run = queue.then(work);
		queue = run.catch((error: unknown) => console.error("[change-hub]", error));
		return run;
	}

	async function snapshot(registered: RegisteredLayer, changed: boolean): Promise<LayerPublication> {
		const data = await registered.layer.snapshot();
		const publication = {
			layer: registered.layer.id,
			version: registered.version + (changed ? 1 : 0),
			data,
		};
		registered.version = publication.version;
		registered.publication = publication;
		return publication;
	}

	function current(): { seq: number; layers: readonly LayerPublication[] } {
		const layers: LayerPublication[] = [];
		for (const registered of registry.values()) {
			const publication = registered.publication;
			if (publication !== undefined) layers.push(publication);
		}
		return { seq, layers };
	}

	async function reconcile(
		registered: RegisteredLayer,
		work: () => Promise<boolean>,
		applying: boolean,
	): Promise<boolean | undefined> {
		let timedOut = false;
		let timer: TimerHandle | undefined;
		if (applying) registered.outstandingApplies += 1;
		const completion = Promise.resolve().then(work).then(
			(changed) => {
				if (applying) registered.outstandingApplies -= 1;
				if (timedOut && (applying || changed)) publish(registered.layer.id);
				return changed;
			},
			(error: unknown) => {
				if (applying) registered.outstandingApplies -= 1;
				console.error(`[change-hub] layer ${registered.layer.id} failed:`, error);
				return undefined;
			},
		);
		try {
			return await Promise.race([
				completion,
				new Promise<undefined>((resolve) => {
					timer = setTimer(() => {
						timedOut = true;
						console.warn(`[change-hub] layer ${registered.layer.id} exceeded ${layerTimeoutMs}ms`);
						resolve(undefined);
					}, layerTimeoutMs);
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimer(timer);
		}
	}

	function publish(layerId: string): void {
		const registered = registry.get(layerId);
		if (registered === undefined) return;
		void serialize(async () => {
			const reconciled = registered.outstandingApplies === 0 ? [layerId] : [];
			const publication = await snapshot(registered, true);
			deps.send({
				seq: ++seq,
				dirs: [],
				layers: [publication],
				reconciled,
			});
		});
	}

	return {
		register(layer): void {
			if (registry.has(layer.id)) throw new Error(`Duplicate layer id: ${layer.id}`);
			if (started) throw new Error("Cannot register a layer after the hub has started");
			registry.set(layer.id, {
				layer,
				version: 0,
				publication: undefined,
				outstandingApplies: 0,
			});
		},
		ingest(batch): void {
			if (pendingDirs !== undefined) {
				pendingDirs.push(batch);
				return;
			}
			const dirs = [batch];
			pendingDirs = dirs;
			void serialize(async () => {
				if (batchWindowMs > 0) {
					await new Promise<void>((resolve) => setTimer(resolve, batchWindowMs));
				}
				if (pendingDirs === dirs) pendingDirs = undefined;
				const layers: LayerPublication[] = [];
				const reconciled: string[] = [];
				for (const registered of registry.values()) {
					const changed = await reconcile(registered, () => registered.layer.applyChanges(dirs), true);
					if (changed === undefined) continue;
					reconciled.push(registered.layer.id);
					try {
						if (changed) layers.push(await snapshot(registered, true));
					} catch (error) {
						console.error(
							`[change-hub] layer ${registered.layer.id} failed:`,
							error instanceof Error ? error : String(error),
						);
					}
				}
				deps.send({ seq: ++seq, dirs, layers, reconciled });
			});
		},
		publish,
		current(): Promise<{ seq: number; layers: readonly LayerPublication[] }> {
			return serialize(async () => current());
		},
		resync(): Promise<LiveResync> {
			return serialize(async () => {
				const reconciled: string[] = [];
				for (const registered of registry.values()) {
					if (registered.layer.resync === undefined) continue;
					const changed = await reconcile(registered, () => registered.layer.resync?.() ?? Promise.resolve(false), false);
					if (changed === undefined) continue;
					reconciled.push(registered.layer.id);
					try {
						if (changed) await snapshot(registered, true);
					} catch (error) {
						console.error(
							`[change-hub] layer ${registered.layer.id} failed:`,
							error instanceof Error ? error : String(error),
						);
					}
				}
				return { ...current(), reconciled };
			});
		},
	};
}
