export const VERSION_FLOORS: Readonly<Record<"minsync" | "dupey" | "@nomadamas/mailcrawl" | "lazykatok", string>>;
export function compareVersions(a: string, b: string): number;
export function assertVersionFloor(name: string, version: string, floor: string): void;
