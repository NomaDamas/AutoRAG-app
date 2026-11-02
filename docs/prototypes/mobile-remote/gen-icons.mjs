#!/usr/bin/env node
/**
 * Regenerate ./icons.js from the `lucide-react` the app pins.
 *
 *   node docs/prototypes/mobile-remote/gen-icons.mjs
 *
 * Same approach as ../settings/gen-lucide-icons.mjs, but it also resolves a
 * slug through lucide's `aliases` (newer lucide renamed e.g. `music` →
 * `eighth-notes`), so the slugs below keep the names icons.tsx imports.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SLUGS = [
	"folder", "folder-open", "folder-plus", "folder-input", "file", "file-text", "file-archive", "file-code",
	"file-spreadsheet", "presentation", "image", "music", "film", "app-window",
	"sparkles", "wand-sparkles", "search", "text-search", "history", "house", "download", "monitor", "hard-drive",
	"cloud", "tag", "trash", "ellipsis", "chevron-left", "chevron-right", "chevron-down", "chevron-up",
	"layout-grid", "list", "arrow-down-up", "layers", "check", "circle-check", "circle", "plus", "share", "info",
	"copy", "pencil", "files", "eye", "zap", "settings", "square-pen", "paperclip", "arrow-up",
	"x", "shield-check", "minimize-2", "refresh-cw", "quote", "plug", "message-circle", "loader-circle",
	"undo-2", "link", "play", "pause", "triangle-alert", "circle-alert", "gauge", "cpu", "globe",
	"list-checks", "rotate-ccw", "bell", "user", "credit-card", "mouse-pointer-click", "keyboard", "database",
	"scan-eye", "mail", "folder-sync", "panel-left", "external-link", "upload", "clipboard-copy",
	"skip-back", "skip-forward", "rotate-cw", "wifi", "volume-2", "square-check-big", "folder-down", "star",
];

const root = new URL("../../../", import.meta.url);
const bundle = readFileSync(new URL("node_modules/lucide-react/dist/cjs/lucide-react.js", root), "utf8");
const { version } = JSON.parse(readFileSync(new URL("node_modules/lucide-react/package.json", root), "utf8"));

/** Offset of the icon object whose `name` or `aliases` is `slug`. */
function iconStart(slug) {
	const byName = bundle.indexOf(`name: ${JSON.stringify(slug)},`);
	if (byName >= 0) return byName;
	const alias = bundle.search(new RegExp(`aliases: \\[[^\\]]*${JSON.stringify(slug)}`));
	if (alias < 0) throw new Error(`lucide-react@${version} has no icon named ${slug}`);
	return bundle.lastIndexOf("name: ", alias);
}

/** The bracket-balanced `node: [...]` literal of that icon. */
function nodeLiteral(slug) {
	const open = bundle.indexOf("[", bundle.indexOf("node: ", iconStart(slug)));
	let depth = 0;
	for (let index = open; index < bundle.length; index++) {
		if (bundle[index] === "[") depth++;
		else if (bundle[index] === "]" && --depth === 0) return bundle.slice(open, index + 1);
	}
	throw new Error(`unterminated node data for ${slug}`);
}

const markup = (node) =>
	node
		.map(([tag, props]) => {
			const attrs = Object.entries(props)
				.filter(([name]) => name !== "key")
				.map(([name, value]) => `${name}="${value}"`)
				.join(" ");
			return `<${tag} ${attrs}/>`;
		})
		.join("");

// The literal is plain data (arrays, objects, strings) from a dependency we already trust.
const entries = SLUGS.map((slug) => `\t${JSON.stringify(slug)}: ${JSON.stringify(markup(new Function(`return ${nodeLiteral(slug)};`)()))},`);

const output = `/**
 * lucide glyphs for the mobile remote prototype.
 *
 * Generated from \`lucide-react@${version}\` by ./gen-icons.mjs. Do not
 * hand-edit; add a slug to that script and rerun it.
 */
"use strict";

const LUCIDE = {
${entries.join("\n")}
};
`;

writeFileSync(fileURLToPath(new URL("icons.js", import.meta.url)), output);
console.log(`wrote ${SLUGS.length} glyphs from lucide-react@${version}`);
