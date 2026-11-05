import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProviderAuthService, type ProviderAuthService } from "../src/main/provider-auth-service";
import type { ProviderCredentialService } from "../src/main/provider-credentials";
import { LOGO_PATHS } from "../src/renderer/src/components/settings/providerLogoPaths";
import { PROVIDER_LOGO_NAMES, providerLogoFor } from "../src/renderer/src/components/settings/providerLogos";
import type { ProviderSummary } from "../src/shared/settings-contract";

const NO_CREDENTIALS: ProviderCredentialService = {
	list: async () => [],
	set: async () => [],
	remove: async () => [],
	load: async () => [],
};

let agentDir: string;
let service: ProviderAuthService;
let catalog: readonly ProviderSummary[];

beforeAll(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "autorag-provider-logos-"));
	service = createProviderAuthService({ send: () => undefined, env: {}, credentials: NO_CREDENTIALS, agentDir });
	// The same list Settings and onboarding draw their provider rows from.
	catalog = await service.list();
});

afterAll(async () => {
	await service.dispose();
	await rm(agentDir, { recursive: true, force: true, maxRetries: 3 });
});

const logoFor = (id: string): readonly { readonly d: string }[] | null => providerLogoFor({ id, kind: "runtime" });

describe("provider logo mapping", () => {
	it("only names providers Pi's catalog really has, so a renamed or dropped provider fails here", () => {
		const builtIn = new Set(catalog.filter((provider) => provider.kind === "runtime").map((provider) => provider.id));
		const stale = Object.keys(PROVIDER_LOGO_NAMES).filter((id) => !builtIn.has(id));
		expect(stale).toEqual([]);
		// Guards the guard: an empty catalog would pass the check above for nothing.
		expect(builtIn.size).toBeGreaterThan(20);
	});

	it("covers the providers the connection lists lead with", () => {
		const required = ["openai", "anthropic", "google", "github-copilot", "openrouter", "xai", "amazon-bedrock", "azure", "meta", "moonshotai", "kimi-coding"];
		expect(required.filter((id) => logoFor(id) === null)).toEqual([]);
	});

	it("gives look-alike names different logos, which was the point of replacing the first letter", () => {
		const paths = ["openai", "openai-codex", "openrouter"].map((id) => logoFor(id)?.map((path) => path.d).join("|"));
		expect(new Set(paths).size).toBe(3);
		const bedrockAzureAntLing = ["amazon-bedrock", "azure", "ant-ling"].map((id) => logoFor(id)?.map((path) => path.d).join("|"));
		expect(new Set(bedrockAzureAntLing).size).toBe(3);
	});

	it("falls back to the letter icon for providers without a logo, local and custom servers, and unknown ids", () => {
		expect(logoFor("radius")).toBeNull();
		expect(logoFor("typesafe")).toBeNull();
		expect(logoFor("not-a-provider")).toBeNull();
		// A server the user named "openai" is not OpenAI.
		expect(providerLogoFor({ id: "openai", kind: "custom" })).toBeNull();
		expect(providerLogoFor({ id: "anthropic", kind: "local" })).toBeNull();
	});

	it("does not resolve inherited object keys to a logo", () => {
		for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty"]) expect(logoFor(id)).toBeNull();
	});

	it("points every mapping at a vendored mark, and vendors no mark that nothing uses", () => {
		const names = new Set(Object.values(PROVIDER_LOGO_NAMES));
		for (const name of names) expect(LOGO_PATHS[name].length).toBeGreaterThan(0);
		expect(Object.keys(LOGO_PATHS).filter((name) => !names.has(name as keyof typeof LOGO_PATHS))).toEqual([]);
	});

	it("keeps each mark to plain path data in the 24 x 24 box", () => {
		for (const [name, paths] of Object.entries(LOGO_PATHS)) {
			for (const path of paths as readonly { readonly d: string; readonly fillOpacity?: number }[]) {
				expect(path.d, name).toMatch(/^[Mm][-+.\d\sA-Za-z,]*$/u);
				if (path.fillOpacity !== undefined) expect(path.fillOpacity, name).toBeGreaterThan(0);
			}
		}
	});

	it("records every vendored mark in THIRD_PARTY_NOTICES.md", async () => {
		const notices = await readFile(join(import.meta.dirname, "..", "THIRD_PARTY_NOTICES.md"), "utf8");
		expect(notices).toContain("@lobehub/icons-static-svg");
		const unlisted = Object.keys(LOGO_PATHS).filter((name) => !notices.includes(`\`${name}\``));
		expect(unlisted).toEqual([]);
	});
});
