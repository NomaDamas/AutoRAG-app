#!/usr/bin/env node
/**
 * Regenerate ./lucide-icons.js from the `lucide-react` the app pins.
 *
 *   node docs/prototypes/settings/gen-lucide-icons.mjs
 *
 * Reads each icon's node data out of the installed CJS bundle and emits the
 * 24 × 24 stroke markup, so the prototype draws the same glyphs as
 * `src/renderer/src/components/icons.tsx` without a CDN or a build step.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SLUGS = [
	"settings",
	"sparkles",
	"search",
	"globe",
	"folder",
	"file-text",
	"copy",
	"plug",
	"chevron-right",
	"chevron-down",
	"check",
	"plus",
	"x",
	"info",
	"triangle-alert",
	"ellipsis",
	"external-link",
	"user",
	"credit-card",
	"refresh-cw",
	"chevron-left",
	"zap",
	"pencil",
	"trash",
	"clock",
	"arrow-up",
	"rotate-ccw-clock",
	"panel-left",
	"layout-grid",
	"list",
	"columns-3",
	"share",
	"house",
	"download",
	"monitor",
	"hard-drive",
	"app-window",
	"arrow-down-up",
	"layers",
	"file",
	"music",
	"film",
	"image",
	"eject",
	"arrow-right",
	"circle-check",
	"circle-dashed",
	"circle-alert",
	"loader-circle",
	"lock",
	"wifi-off",
	"folder-x",
	"clipboard-copy",
	"key-round",
	"cpu",
	"rotate-ccw",
	"scan-eye",
	"mail",
	"sun",
	"moon",
	"minus",
	"shield-check",
	"cloud",
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
 * lucide glyphs for the settings prototype.
 *
 * Generated from \`lucide-react@${version}\` — the same library the app pins in
 * \`src/renderer/src/components/icons.tsx\` — by ./gen-lucide-icons.mjs. Do not
 * hand-edit; add a slug to that script and rerun it.
 */
"use strict";

const LUCIDE = {
${entries.join("\n")}
};
`;

writeFileSync(fileURLToPath(new URL("lucide-icons.js", import.meta.url)), output);
console.log(`wrote ${SLUGS.length} glyphs from lucide-react@${version}`);
