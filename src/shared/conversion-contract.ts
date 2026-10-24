/**
 * Convert-on-rename — typing a different extension into a file's name converts
 * the file to that format with Filee instead of only relabelling it.
 *
 * The renderer owns the rename UI; main owns the Filee process and every file
 * it writes. `plan` is a pure question about two names (no disk, no download),
 * `run` does the conversion into the new name, and `cancel` stops one that is
 * still running. All paths crossing this boundary are absolute OS paths.
 */

/** IPC channel names. Keep in 1:1 sync with the main-process handlers. */
export const CONVERSION_CHANNELS = {
	plan: "conversion:plan",
	run: "conversion:run",
	cancel: "conversion:cancel",
} as const;

export type ConversionChannel = (typeof CONVERSION_CHANNELS)[keyof typeof CONVERSION_CHANNELS];

/**
 * What a rename means. Extensions are lower-case without the dot, spelled as
 * the user typed them.
 * - `rename`: not a format change (same format, no extension on either side,
 *   or conversion switched off) — a plain rename.
 * - `convert`: the file can become the new format.
 * - `unsupported`: both extensions are present but no route exists; nothing happens.
 */
export type ConversionPlan =
	| { readonly kind: "rename" }
	| { readonly kind: "convert"; readonly from: string; readonly to: string }
	| { readonly kind: "unsupported"; readonly from: string; readonly to: string };

/** One conversion into a new file name inside the source's folder. */
export interface ConversionRequest {
	/** Caller-chosen id, the handle `cancel` takes. */
	readonly id: string;
	/** The file to convert. It is never modified or removed. */
	readonly path: string;
	/** The new file's name (with the new extension), created beside `path`. */
	readonly newName: string;
}

export interface ConversionOutcome {
	/** The file or, for a multi-file result, the folder that holds the converted pages. */
	readonly output: string;
	/** Completion note for the toast, already in the UI's language. */
	readonly note: string;
}

/** Exposed to the Finder window as `window.autorag.conversion`. */
export interface ConversionBridge {
	plan(oldName: string, newName: string): Promise<ConversionPlan>;
	/** Rejects with a user-readable message when the conversion fails or is cancelled. */
	run(request: ConversionRequest): Promise<ConversionOutcome>;
	cancel(id: string): Promise<void>;
}

export function isConversionRequest(value: unknown): value is ConversionRequest {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.id === "string" &&
		record.id.length > 0 &&
		typeof record.path === "string" &&
		record.path.length > 0 &&
		typeof record.newName === "string" &&
		record.newName.length > 0
	);
}

/** The bridge when the real one is absent (fixture source): every rename stays a plain rename. */
export const NO_CONVERSION: ConversionBridge = {
	plan: () => Promise.resolve({ kind: "rename" }),
	run: () => Promise.reject(new Error("File conversion is unavailable.")),
	cancel: () => Promise.resolve(),
};
