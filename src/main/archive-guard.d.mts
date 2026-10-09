/** Types for {@link ./archive-guard.mjs}, which is plain JavaScript so the libarchive worker can share it. */
export class ArchiveError extends Error {}

/** Strip leading `./` prefixes; a lone `.`/`./` becomes "". */
export function normalizeEntryName(name: string): string;

/** The absolute path an entry extracts to; refuses absolute/`..`/NUL/Windows-drive names. */
export function archiveEntryPath(destDir: string, name: string): { readonly path: string; readonly directory: boolean };
