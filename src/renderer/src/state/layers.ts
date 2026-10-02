import {
	DUPEY_LAYER_ID,
	type LayerPublication,
	type LiveMessage,
	type LiveResync,
} from "../../../shared/live-contract";
import {
	EMPTY_VERSION_FAMILIES_RESULT,
	type VersionFamiliesResult,
} from "./version-family";

export interface LayerStore {
	readonly versions: Readonly<Record<string, number>>;
	readonly data: Readonly<Record<string, unknown>>;
	readonly pendingThrough: Readonly<Record<string, number>>;
}

export const EMPTY_LAYER_STORE: LayerStore = {
	versions: {},
	data: {},
	pendingThrough: {},
};

function registeredLayerIds(store: LayerStore): Set<string> {
	return new Set([
		DUPEY_LAYER_ID,
		...Object.keys(store.versions),
		...Object.keys(store.data),
		...Object.keys(store.pendingThrough),
	]);
}

function adoptPublication(
	store: LayerStore,
	publication: LayerPublication,
): LayerStore {
	const currentVersion = store.versions[publication.layer] ?? 0;
	if (publication.version <= currentVersion) {
		return store;
	}
	return {
		...store,
		versions: { ...store.versions, [publication.layer]: publication.version },
		data: { ...store.data, [publication.layer]: publication.data },
	};
}

function clearReconciledFences(
	pendingThrough: Readonly<Record<string, number>>,
	reconciled: readonly string[],
	seq: number,
): Readonly<Record<string, number>> {
	const next = { ...pendingThrough };
	for (const layerId of reconciled) {
		if (next[layerId] !== undefined && next[layerId] <= seq) {
			delete next[layerId];
		}
	}
	return next;
}

export function adoptMessage(store: LayerStore, message: LiveMessage): LayerStore {
	let next = store;
	for (const publication of message.layers) {
		next = adoptPublication(next, publication);
	}

	const pendingThrough = { ...next.pendingThrough };
	if (message.dirs.length > 0) {
		for (const layerId of registeredLayerIds(next)) {
			if (!message.reconciled.includes(layerId)) {
				pendingThrough[layerId] = Math.max(pendingThrough[layerId] ?? -1, message.seq);
			}
		}
	}
	next = { ...next, pendingThrough };
	return {
		...next,
		pendingThrough: clearReconciledFences(next.pendingThrough, message.reconciled, message.seq),
	};
}

export function adoptResync(store: LayerStore, resync: LiveResync): LayerStore {
	let next = store;
	for (const publication of resync.layers) {
		next = adoptPublication(next, publication);
	}
	return {
		...next,
		pendingThrough: clearReconciledFences(next.pendingThrough, resync.reconciled, resync.seq),
	};
}

export function adoptInvoke(
	store: LayerStore,
	layerId: string,
	data: unknown,
	versionAtRequest: number,
): LayerStore {
	if ((store.versions[layerId] ?? 0) !== versionAtRequest) {
		return store;
	}
	return { ...store, data: { ...store.data, [layerId]: data } };
}

export function selectDupey(store: LayerStore): {
	readonly result: VersionFamiliesResult;
	readonly fenced: boolean;
} {
	return {
		result: (store.data[DUPEY_LAYER_ID] as VersionFamiliesResult | undefined) ?? EMPTY_VERSION_FAMILIES_RESULT,
		fenced: store.pendingThrough[DUPEY_LAYER_ID] !== undefined,
	};
}
