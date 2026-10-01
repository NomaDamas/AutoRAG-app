export const INDEX_CHANNELS = {
	status: "index:status",
	setExcluded: "index:setExcluded",
} as const;

export type IndexStatusKind = "included" | "excluded" | "pending" | "skipped";

export interface IndexStatus {
	readonly path: string;
	readonly kind: IndexStatusKind;
	readonly detail: string;
	readonly toggleable: boolean;
}
