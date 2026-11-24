/**
 * Where a filename search looks. The result screen (Figma 428:1845) has no scope row, so a search covers the whole
 * computer ("all"); "current" is kept for searches started inside a folder by code.
 */
export type SearchScope = "all" | "current";
