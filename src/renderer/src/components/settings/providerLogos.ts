/**
 * Which logo a provider is drawn with in the connection lists (Settings → AI 모델, the model picker, the
 * onboarding model step). Keys are the Pi provider ids `providersList` returns; values are names in
 * `providerLogoPaths.ts`. A provider with no entry (Radius, TypeSafe, Xiaomi, every local/custom server)
 * keeps the first-letter icon. `test/provider-logos.test.ts` checks every key against Pi's real catalog,
 * so a provider Pi renames or drops fails there instead of silently losing its logo.
 *
 * Several ids share a logo when they are regional or plan variants of one vendor. The logos are monochrome
 * and drawn in `currentColor`, so they follow the theme with no per-theme variant.
 */

import type { ProviderKind } from "../../../../shared/settings-contract";
import { LOGO_PATHS, type LogoName, type LogoPath } from "./providerLogoPaths";

export const PROVIDER_LOGO_NAMES: Readonly<Record<string, LogoName>> = {
	"amazon-bedrock": "bedrock",
	"ant-ling": "ling",
	anthropic: "anthropic",
	azure: "azure",
	baseten: "baseten",
	cerebras: "cerebras",
	"cloudflare-ai-gateway": "cloudflare",
	"cloudflare-workers-ai": "workersai",
	deepseek: "deepseek",
	fireworks: "fireworks",
	"github-copilot": "githubcopilot",
	// The Gemini API provider: its models are Gemini, and Vertex AI below keeps its own mark.
	google: "gemini",
	"google-vertex": "vertexai",
	groq: "groq",
	huggingface: "huggingface",
	"kimi-coding": "kimi",
	meta: "meta",
	minimax: "minimax",
	"minimax-cn": "minimax",
	mistral: "mistral",
	moonshotai: "moonshot",
	"moonshotai-cn": "moonshot",
	nvidia: "nvidia",
	openai: "openai",
	// The legacy ChatGPT-subscription sign-in; Codex's own mark tells it apart from OpenAI's API entry.
	"openai-codex": "codex",
	opencode: "opencode",
	"opencode-go": "opencode",
	openrouter: "openrouter",
	"qwen-token-plan": "qwen",
	"qwen-token-plan-cn": "qwen",
	"qwen-token-plan-individual": "qwen",
	together: "together",
	"vercel-ai-gateway": "vercel",
	xai: "xai",
	zai: "zai",
	"zai-coding-cn": "zai",
};

/**
 * The marks to draw for a provider, or `null` for the first-letter icon. Only Pi's built-in providers are
 * looked up: a local or custom server's id comes from a name the user typed, so a server called "OpenAI"
 * must not borrow the OpenAI logo.
 */
export function providerLogoFor(provider: { readonly id: string; readonly kind: ProviderKind }): readonly LogoPath[] | null {
	if (provider.kind !== "runtime" || !Object.hasOwn(PROVIDER_LOGO_NAMES, provider.id)) return null;
	const name = PROVIDER_LOGO_NAMES[provider.id];
	return name === undefined ? null : LOGO_PATHS[name];
}
