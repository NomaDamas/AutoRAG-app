import { useMemo } from "react";
import type { FsBridge } from "../../../shared/fs-contract";
import type { LiveBridge } from "../../../shared/live-contract";
import { createBridgeSource, createFixtureSource, type FinderSource } from "../data/source";

/**
 * Resolves the Finder's data port once per session.
 *
 * `window.autorag.fs` exists in the packaged app. Anywhere else — vitest, a
 * plain browser, a renderer opened before the preload lands — the fixture
 * source takes over so the UI always renders.
 */
export function useFinderSource(): FinderSource {
	return useMemo(() => {
		const autorag =
			typeof window === "undefined"
				? undefined
				: (window as { autorag?: { fs?: FsBridge; live?: LiveBridge } }).autorag;
		return autorag?.fs === undefined || autorag.live === undefined
			? createFixtureSource()
			: createBridgeSource(autorag.fs, "", autorag.live);
	}, []);
}
