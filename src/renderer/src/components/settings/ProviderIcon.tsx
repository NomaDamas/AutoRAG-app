/**
 * The mark of an AI service: the provider's own logo (nominative use — the
 * icon names the service the connection talks to). Marks come from
 * `simple-icons` (CC0), matched on the provider id; a provider it does not
 * ship falls back to a neutral lucide glyph for its kind (a server on this
 * computer, a custom gateway, or a hosted service).
 */

import type { ReactElement } from "react";
import { Bot, Globe, Server } from "lucide-react";
import {
	siAnthropic,
	siDeepseek,
	siGithubcopilot,
	siGooglegemini,
	siHuggingface,
	siMinimax,
	siMistralai,
	siMoonshotai,
	siNvidia,
	siOllama,
	siOpenrouter,
	siPerplexity,
	siQwen,
	siVercel,
	siX,
	type SimpleIcon,
} from "simple-icons";
import type { ProviderSummary } from "../../../../shared/settings-contract";
import { brandFill } from "./SourceIcon";

/** Provider-id prefixes and the logo each names; the first match wins. */
const BRAND_BY_PREFIX: readonly (readonly [string, SimpleIcon])[] = [
	["anthropic", siAnthropic],
	["github-copilot", siGithubcopilot],
	["google", siGooglegemini],
	["gemini", siGooglegemini],
	["xai", siX],
	["huggingface", siHuggingface],
	["mistral", siMistralai],
	["deepseek", siDeepseek],
	["openrouter", siOpenrouter],
	["vercel", siVercel],
	["nvidia", siNvidia],
	["perplexity", siPerplexity],
	["minimax", siMinimax],
	["moonshot", siMoonshotai],
	["kimi", siMoonshotai],
	["qwen", siQwen],
	["ollama", siOllama],
];

function brandFor(provider: ProviderSummary): SimpleIcon | undefined {
	const id = provider.id.toLowerCase();
	const hit = BRAND_BY_PREFIX.find(([prefix]) => id.startsWith(prefix));
	if (hit !== undefined) return hit[1];
	// A server on this computer is most often Ollama, on its default port.
	if (provider.kind === "local" && /ollama|:11434\b/iu.test(`${provider.name} ${provider.baseUrl ?? ""}`)) return siOllama;
	return undefined;
}

export function ProviderIcon({ provider, size = 20 }: { readonly provider: ProviderSummary; readonly size?: number }): ReactElement {
	const brand = brandFor(provider);
	if (brand !== undefined) {
		return (
			<svg viewBox="0 0 24 24" width={size} height={size} role="img" aria-label={provider.name} focusable="false">
				<path d={brand.path} fill={brandFill(brand.hex)} />
			</svg>
		);
	}
	const Glyph = provider.kind === "local" ? Server : provider.kind === "custom" ? Globe : Bot;
	return <Glyph size={size} aria-label={provider.name} role="img" focusable="false" />;
}
