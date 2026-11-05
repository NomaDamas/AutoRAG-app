/**
 * Regenerate `src/renderer/src/components/settings/providerLogoPaths.ts`, the vendored provider logo
 * path data, from the static SVGs of `@lobehub/icons-static-svg` (MIT, Copyright (c) 2023 LobeHub).
 *
 *   mkdir /tmp/lobe && curl -sL "$(pnpm view @lobehub/icons-static-svg@<version> dist.tarball)" | tar xz -C /tmp/lobe
 *   node scripts/brand/vendor-provider-logos.mjs /tmp/lobe/package
 *
 * Only the monochrome files (`<name>.svg`, drawn in `currentColor`) are taken, so a logo follows the
 * surrounding text color in the light and the dark theme. The script refuses any file that uses more
 * than flat `<path>`s (gradients, transforms, strokes, a second viewBox ...) instead of guessing; the
 * `-color` variants all fail that check on purpose. Add a logo by adding its file name to `LOGOS`,
 * then map the provider id to it in `providerLogos.ts` and record the brand in THIRD_PARTY_NOTICES.md.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUTPUT = join(root, "src", "renderer", "src", "components", "settings", "providerLogoPaths.ts");

/** lobehub file names (without `.svg`) that the provider mapping uses. Keep sorted. */
const LOGOS = [
	"anthropic",
	"azure",
	"baseten",
	"bedrock",
	"cerebras",
	"cloudflare",
	"codex",
	"deepseek",
	"fireworks",
	"gemini",
	"githubcopilot",
	"groq",
	"huggingface",
	"kimi",
	"ling",
	"meta",
	"minimax",
	"mistral",
	"moonshot",
	"nvidia",
	"openai",
	"opencode",
	"openrouter",
	"qwen",
	"together",
	"vercel",
	"vertexai",
	"workersai",
	"xai",
	"zai",
];

const source = process.argv[2];
if (source === undefined) {
	console.error("usage: node scripts/brand/vendor-provider-logos.mjs <unpacked @lobehub/icons-static-svg directory>");
	process.exit(2);
}
const packageDir = resolve(source);
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
if (manifest.name !== "@lobehub/icons-static-svg" || manifest.license !== "MIT") {
	throw new Error(`expected the MIT @lobehub/icons-static-svg package, found ${manifest.name} (${manifest.license})`);
}

const ATTRIBUTE = /([a-zA-Z:-]+)="([^"]*)"/gu;

function attributes(tag) {
	const found = {};
	for (const match of tag.matchAll(ATTRIBUTE)) found[match[1]] = match[2];
	return found;
}

function parse(name) {
	const svg = readFileSync(join(packageDir, "icons", `${name}.svg`), "utf8").trim();
	const tags = [...svg.matchAll(/<([a-zA-Z]+)\b[^>]*>/gu)].map((match) => match[1]);
	const stray = tags.filter((tag) => tag !== "svg" && tag !== "title" && tag !== "path");
	if (stray.length > 0) throw new Error(`${name}: unsupported element <${stray[0]}>`);
	const svgAttrs = attributes(/<svg\b[^>]*>/u.exec(svg)?.[0] ?? "");
	if (svgAttrs.viewBox !== "0 0 24 24" || svgAttrs.fill !== "currentColor" || svgAttrs["fill-rule"] !== "evenodd") {
		throw new Error(`${name}: expected a 24x24 currentColor evenodd mark, found ${JSON.stringify(svgAttrs)}`);
	}
	const paths = [...svg.matchAll(/<path\b[^>]*>/gu)].map((match) => {
		const attrs = attributes(match[0]);
		const extra = Object.keys(attrs).filter((key) => key !== "d" && key !== "fill-opacity" && key !== "clip-rule");
		if (extra.length > 0 || attrs.d === undefined) throw new Error(`${name}: unsupported path attribute ${extra[0] ?? "d"}`);
		return { d: attrs.d, ...(attrs["fill-opacity"] === undefined ? {} : { fillOpacity: Number(attrs["fill-opacity"]) }) };
	});
	if (paths.length === 0) throw new Error(`${name}: no path`);
	return paths;
}

const entries = LOGOS.map((name) => {
	const lines = parse(name).map((path) => `\t\t{ d: ${JSON.stringify(path.d)}${path.fillOpacity === undefined ? "" : `, fillOpacity: ${path.fillOpacity}`} },`);
	return `\t${name}: [\n${lines.join("\n")}\n\t],`;
});

writeFileSync(
	OUTPUT,
	`/**
 * Provider logo marks, one monochrome mark per name, 24 x 24 viewBox, drawn in \`currentColor\` with the
 * even-odd fill rule.
 *
 * Vendored from \`@lobehub/icons-static-svg\` ${manifest.version} (MIT, Copyright (c) 2023 LobeHub,
 * https://github.com/lobehub/lobe-icons). The license covers the files, not the marks: every logo here is a
 * trademark of its owner and only identifies that provider in the connection lists (nominative use); see
 * THIRD_PARTY_NOTICES.md. Do not edit by hand: \`node scripts/brand/vendor-provider-logos.mjs <package dir>\`
 * rewrites this file, and \`providerLogos.ts\` maps provider ids to these names.
 */

export interface LogoPath {
	readonly d: string;
	readonly fillOpacity?: number;
}

export const LOGO_PATHS = {
${entries.join("\n")}
} as const satisfies Record<string, readonly LogoPath[]>;

export type LogoName = keyof typeof LOGO_PATHS;
`,
);
console.log(`wrote ${OUTPUT} (${LOGOS.length} logos from @lobehub/icons-static-svg ${manifest.version})`);
