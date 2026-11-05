/**
 * The filesystem without Electron's asar patch.
 *
 * Inside Electron, `node:fs` treats every `*.asar` file as a directory to read
 * from: reading the file itself fails with "ENOENT, not found in …asar" (or
 * "Invalid package" when it is not a real archive). Code that reads arbitrary
 * user files byte for byte — the archivers — must not take that detour, so it
 * uses Electron's `original-fs`, and plain `node:fs` where Electron is absent
 * (tests, the fs worker under Node).
 */

import type * as NodeFs from "node:fs";
import { createRequire } from "node:module";

// Not named `require`: the main bundle declares its own at module scope, and a second one is a SyntaxError at load.
const loadModule = createRequire(import.meta.url);

// `original-fs` exists only in Electron's runtime, so it is required by name at run time.
export const rawFs: typeof NodeFs = process.versions.electron !== undefined ? (loadModule("original-fs") as typeof NodeFs) : (loadModule("node:fs") as typeof NodeFs);
