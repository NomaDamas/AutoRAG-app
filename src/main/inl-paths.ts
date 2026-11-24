import { join } from "node:path";

/**
 * The im-not-llm (`inl`) per-user root every NomaDamas runtime shares: `~/.cache/im-not-llm`
 * (`%LOCALAPPDATA%\im-not-llm` on Windows), the same path `inl-core`'s `cache_root()` and `inl-server`'s
 * `default_state_dir()` use. `inl serve` owns the model weights and the loopback daemon; MinSync (which links
 * the inl-server crates) and this app find the same daemon and the same copy of a model here, so no consumer
 * keeps a private root.
 */
export function inlCacheRoot(options: { readonly platform?: NodeJS.Platform; readonly home: string; readonly env?: NodeJS.ProcessEnv }): string {
	if ((options.platform ?? process.platform) === "win32") {
		const localAppData = options.env?.LOCALAPPDATA?.trim();
		const root = localAppData !== undefined && localAppData.length > 0 ? localAppData : join(options.home, "AppData", "Local");
		return join(root, "im-not-llm");
	}
	return join(options.home, ".cache", "im-not-llm");
}

/**
 * The weight cache the `inl` engines read models from, in the Hugging Face hub layout
 * (`models--Org--Name/{refs,snapshots,blobs}`): `INL_CACHE_DIR` when set, else `<cache root>/models`.
 */
export function inlModelCacheRoot(options: { readonly platform?: NodeJS.Platform; readonly home: string; readonly env?: NodeJS.ProcessEnv }): string {
	const override = options.env?.INL_CACHE_DIR?.trim();
	if (override !== undefined && override.length > 0) return override;
	return join(inlCacheRoot(options), "models");
}

/** Where a running daemon publishes its `host`/`port`/`pid`/`lock`, per model instance: `<cache root>/serve`. */
export function inlServeStateRoot(options: { readonly platform?: NodeJS.Platform; readonly home: string; readonly env?: NodeJS.ProcessEnv }): string {
	return join(inlCacheRoot(options), "serve");
}
