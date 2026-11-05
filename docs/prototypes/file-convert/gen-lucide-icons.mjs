#!/usr/bin/env node
/**
 * Regenerate ./lucide-icons.js from the `lucide-react` the app pins.
 *
 *   node docs/prototypes/file-convert/gen-lucide-icons.mjs
 *
 * Same approach as ../settings/gen-lucide-icons.mjs: read each icon's node data
 * out of the installed CJS bundle and emit the 24 x 24 stroke markup, so the
 * prototypes draw the glyphs `src/renderer/src/components/icons.tsx` draws,
 * without a CDN or a build step.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SLUGS = [
	"panel-left", "search", "chevron-left", "chevron-right", "chevron-down", "layout-grid", "list", "columns-3",
	"arrow-up-down", "layers", "info", "sparkles", "share", "house", "app-window", "monitor", "file-text", "download",
	"music", "film", "image", "trash", "folder", "clock", "cloud", "hard-drive", "settings", "check", "x",
	"refresh-cw", "arrow-right", "arrow-right-left", "circle-alert", "triangle-alert", "plus", "wand-sparkles", "zap",
	"package", "sliders-horizontal", "ellipsis", "corner-down-left", "play", "undo-2", "external-link", "circle-check",
	"scaling", "hard-drive-download", "file", "folder-open", "gauge", "pencil", "copy",
	"eye", "file-output", "hand", "mail", "smartphone", "printer", "link", "file-check",
];

const root = new URL("../../../", import.meta.url);
const bundle = readFileSync(new URL("node_modules/lucide-react/dist/cjs/lucide-react.js", root), "utf8");
const { version } = JSON.parse(readFileSync(new URL("node_modules/lucide-react/package.json", root), "utf8"));

/** The bracket-balanced `node: [...]` literal that follows `name: "<slug>"`. */
function nodeLiteral(slug) {
	const start = bundle.indexOf(`name: ${JSON.stringify(slug)},`);
	if (start < 0) throw new Error(`lucide-react@${version} has no icon named ${slug}`);
	const open = bundle.indexOf("[", bundle.indexOf("node: ", start));
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
 * lucide glyphs for the file-convert prototypes.
 *
 * Generated from \`lucide-react@${version}\` by ./gen-lucide-icons.mjs.
 * Do not hand-edit; add a slug to that script and rerun it.
 */
"use strict";

const LUCIDE = {
${entries.join("\n")}
};
`;

writeFileSync(fileURLToPath(new URL("./lucide-icons.js", import.meta.url)), output);
console.log(`wrote ${SLUGS.length} icons from lucide-react@${version}`);
