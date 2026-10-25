import { useMemo } from "react";
import type { ActionsBridge } from "../../../shared/actions-contract";
import type { ConversionBridge } from "../../../shared/conversion-contract";
import type { FsBridge } from "../../../shared/fs-contract";
import type { LiveBridge } from "../../../shared/live-contract";
import type { ServicesBridge } from "../../../shared/services-contract";
import { createBridgeSource, createFixtureSource, type FinderSource } from "../data/source";

/**
 * The preload surface as this hook needs it — every member optional, because
 * outside the packaged app (vitest, a plain browser, a renderer opened before
 * the preload lands) it is simply absent.
 */
interface PreloadGlobals {
	readonly autorag?: {
		readonly fs?: FsBridge;
		readonly live?: LiveBridge;
		readonly actions?: ActionsBridge;
		readonly services?: ServicesBridge;
		readonly conversion?: ConversionBridge;
	};
}

/**
 * Resolves the Finder's data port once per session.
 *
 * `window.autorag.fs` exists in the packaged app. Anywhere else the fixture
 * source takes over so the UI always renders.
 */
export function useFinderSource(): FinderSource {
	return useMemo(() => {
		const globals: PreloadGlobals = typeof window === "undefined" ? {} : window;
		const autorag = globals.autorag;
		return autorag?.fs === undefined || autorag.live === undefined
			? createFixtureSource()
			: createBridgeSource(autorag.fs, "", autorag.live, autorag.actions, autorag.services, autorag.conversion);
	}, []);
}
