// The local-embedding spec guard in the real built app, on machines the lane
// pretends to be (AUTORAG_QA_HARDWARE, honored only by unpackaged builds) and on
// the machine it actually runs on.
//
//   bun scripts/manual-qa/run-qa-local-embedding-spec.mjs            # every pretend machine, then this one
//   bun scripts/manual-qa/run-qa-local-embedding-spec.mjs real       # only this machine
//
// Per machine it checks the onboarding embedding step (card state, the reason on
// the card, the explaining toast, what a saved "local" draft turns into) and
// Settings → AI Models → document understanding (the profile is marked and cannot
// be chosen). Onboarding runs in all four interface languages on a weak machine.
// Screenshots go to .omo/evidence/local-embedding-spec/.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, onboardingWindow, ROOT } from "./launch-finder.mjs";
import { rmRetry } from "./platform.mjs";

const EVIDENCE = join(ROOT, ".omo/evidence/local-embedding-spec");
mkdirSync(EVIDENCE, { recursive: true });
const GIB = 1024 ** 3;
const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};

const mac = (cpuModel, gib) => ({ platform: "darwin", arch: "arm64", cpuModel, memoryBytes: gib * GIB, gpus: [] });
const pc = (platform, gpus) => ({ platform, arch: "x64", cpuModel: "QA CPU", memoryBytes: 64 * GIB, gpus });

/** `reason` is the substring of the English reason the machine must be refused with; null means it must pass. */
const MACHINES = [
	{ name: "M4 Max 64 GB", hardware: mac("Apple M4 Max", 64), reason: null },
	{ name: "M2 Pro 32 GB (the minimum)", hardware: mac("Apple M2 Pro", 32), reason: null },
	{ name: "M5 base 32 GB", hardware: mac("Apple M5", 32), reason: "base Apple M5 chip" },
	{ name: "M3 Pro 18 GB", hardware: mac("Apple M3 Pro", 18), reason: "18 GB of unified memory" },
	{ name: "Intel Mac", hardware: { ...mac("Intel(R) Core(TM) i9", 64), arch: "x64" }, reason: "You need Apple silicon" },
	{ name: "Windows RTX 4060 8 GB", hardware: pc("win32", [{ name: "NVIDIA GeForce RTX 4060", vramMiB: 8188 }]), reason: null },
	{ name: "Linux RTX 3050 6 GB", hardware: pc("linux", [{ name: "NVIDIA GeForce RTX 3050", vramMiB: 6144 }]), reason: "has 6 GB of VRAM" },
	{ name: "Windows without a GPU", hardware: pc("win32", []), reason: "No CUDA-capable NVIDIA GPU" },
];

const SPEC_COPY = {
	ko: "최소 사양을 충족하지 못해",
	en: "doesn't meet the minimum spec",
	ja: "最小要件を満たしていません",
	zh: "未达到本地嵌入的最低配置",
};

function seedDraft(userDataDir, embed) {
	const draft = {
		version: 1,
		stepId: "embedding",
		notifications: false,
		network: false,
		launchAtLogin: false,
		folders: [{ path: tmpdir(), selected: true }],
		embed,
		cloudConsent: false,
		sources: [],
		plan: "free",
		planConfirmed: false,
		model: null,
	};
	mkdirSync(join(userDataDir, "onboarding"), { recursive: true });
	writeFileSync(join(userDataDir, "onboarding", "state.json"), JSON.stringify({ completed: false, draft }));
}

async function withApp({ hardware, language, embed, onboarding }, run) {
	const work = mkdtempSync(join(tmpdir(), "autorag-qa-localspec-"));
	const userDataDir = join(work, "user-data");
	if (onboarding) seedDraft(userDataDir, embed);
	const configPath = join(work, "config.json");
	writeFileSync(configPath, `${JSON.stringify({ searchPaths: [work], workspacePath: work, memoryPath: join(work, "memory.json") }, null, 2)}\n`);
	const env = {
		AUTORAG_HOME: work,
		AUTORAG_CONFIG: configPath,
		AUTORAG_SKIP_DUPEY_CHECK: "1",
		...(hardware === null ? {} : { AUTORAG_QA_HARDWARE: JSON.stringify(hardware) }),
	};
	const app = await launchFinder({ userDataDir, env, onboarding, language });
	try {
		const page = await (onboarding ? onboardingWindow(app, 20_000) : finderWindow(app, 20_000));
		return await run(page, { work, configPath });
	} finally {
		await app.close().catch(() => undefined);
		rmRetry(work);
	}
}

const card = (page, mode) => page.locator(`.onb .em-card[data-value="${mode}"]`);

async function onboardingEmbedding(page) {
	await page.waitForSelector(".onb .em-card", { timeout: 20_000 });
	// The machine is checked when the screen loads; wait for the verdict to land on the cards.
	await page.waitForFunction(() => document.querySelector('.onb .em-card[data-value="local"]') !== null, null, { timeout: 5000 });
	await page.waitForTimeout(400);
	return {
		localDisabled: (await card(page, "local").getAttribute("aria-disabled")) === "true",
		blockedText: (await page.locator('.onb .em-blocked[data-for="local"]').count()) === 0 ? null : await page.locator('.onb .em-blocked[data-for="local"]').innerText(),
		checked: await page.locator(".onb .em-card[aria-checked='true']").evaluateAll((nodes) => nodes.map((node) => node.dataset.value)),
		noneDisabled: (await card(page, "none").getAttribute("aria-disabled")) === "true",
	};
}

async function settingsPicker(page) {
	await page.waitForSelector('[role="row"]');
	await page.locator(".sidebar__item--settings").click();
	await page.waitForSelector(".settings-panel");
	await page.locator(".settings-nav-item", { hasText: "AI Models" }).first().click();
	await page.locator(".linear-row", { hasText: "Document Understanding Model" }).locator(".settings-trigger").click();
	await page.waitForSelector('input[name="embedding-profile"]');
	return page.locator('input[name="embedding-profile"]').evaluateAll((inputs) =>
		inputs.map((input) => ({
			disabled: input.getAttribute("aria-disabled") === "true",
			text: input.closest("label")?.innerText ?? "",
		})),
	);
}

const only = process.argv[2]?.trim();
if (only !== "real") {
	for (const machine of MACHINES) {
		console.log(`\n=== ${machine.name} ===`);
		const slug = machine.name.replace(/[^a-z0-9]+/giu, "-").toLowerCase();
		await withApp({ hardware: machine.hardware, language: "en", embed: "local", onboarding: true }, async (page) => {
			const state = await onboardingEmbedding(page);
			const pass = machine.reason === null;
			check(`${machine.name}: local card ${pass ? "is usable" : "is disabled"}`, state.localDisabled === !pass, JSON.stringify(state));
			check(`${machine.name}: the other two cards stay usable offline-wise (keyword-only never blocked)`, !state.noneDisabled);
			if (pass) {
				check(`${machine.name}: a saved local draft stays local`, state.checked.join() === "local", state.checked.join());
				check(`${machine.name}: no blocked line`, state.blockedText === null);
			} else {
				check(`${machine.name}: the reason names the failing requirement`, state.blockedText?.includes(machine.reason) === true, state.blockedText ?? "(none)");
				check(`${machine.name}: a saved local draft falls back to keyword-only`, state.checked.join() === "none", state.checked.join());
				await card(page, "local").click({ force: true });
				await page.waitForFunction(() => document.querySelector(".onb .toast.show")?.textContent?.includes("minimum spec") === true, null, { timeout: 3000 }).catch(() => undefined);
				const toast = await page.locator(".onb .toast").innerText();
				check(`${machine.name}: clicking the local card explains instead of selecting`, toast.includes("minimum spec"), toast);
				check(`${machine.name}: the selection did not move to local`, (await card(page, "local").getAttribute("aria-checked")) === "false");
				await card(page, "none").click();
				check(`${machine.name}: keyword-only can still be chosen`, (await card(page, "none").getAttribute("aria-checked")) === "true");
			}
			await page.locator(".onb").screenshot({ path: join(EVIDENCE, `onboarding-${slug}.png`) });
		});
		await withApp({ hardware: machine.hardware, language: "en", embed: "none", onboarding: false }, async (page) => {
			const rows = await settingsPicker(page);
			const local = rows[1];
			const pass = machine.reason === null;
			check(`${machine.name}: Settings lists the four profiles`, rows.length === 4, String(rows.length));
			check(`${machine.name}: Settings marks the local model ${pass ? "available" : "unavailable"}`, local?.disabled === !pass, JSON.stringify(local));
			if (!pass) check(`${machine.name}: Settings shows the reason`, local?.text.includes(machine.reason) === true, local?.text ?? "");
			if (!pass) {
				await page.locator('input[name="embedding-profile"]').nth(1).click({ force: true });
				const error = await page.locator(".settings-modal-error").innerText().catch(() => "");
				check(`${machine.name}: choosing it in Settings explains and does not select it`, error.includes("minimum spec") && !(await page.locator('input[name="embedding-profile"]').nth(1).isChecked()), error);
			}
			await page.locator(".settings-modal, [role='dialog']").first().screenshot({ path: join(EVIDENCE, `settings-${slug}.png`) }).catch(() => undefined);
		});
	}

	console.log("\n=== a weak machine in every interface language ===");
	for (const language of ["ko", "en", "ja", "zh"]) {
		await withApp({ hardware: mac("Apple M2", 16), language, embed: "none", onboarding: true }, async (page) => {
			const state = await onboardingEmbedding(page);
			check(`${language}: the card carries the translated reason`, state.blockedText?.includes(SPEC_COPY[language]) === true, state.blockedText ?? "(none)");
			check(`${language}: no raw key leaks`, state.blockedText?.includes("localSpec.") === false);
			await page.locator(".onb").screenshot({ path: join(EVIDENCE, `onboarding-weak-${language}.png`) });
		});
	}
}

if (only === undefined || only === "real") {
	console.log("\n=== this machine, no override ===");
	await withApp({ hardware: null, language: "en", embed: "local", onboarding: true }, async (page) => {
		const state = await onboardingEmbedding(page);
		console.log(`INFO cpu: ${cpus()[0]?.model} ; card: ${JSON.stringify(state)}`);
		check("the card is disabled exactly when the reason is shown", state.localDisabled === (state.blockedText !== null));
		check("a disabled local card never stays selected", !state.localDisabled || state.checked.join() === "none", state.checked.join());
		await page.locator(".onb").screenshot({ path: join(EVIDENCE, "onboarding-this-machine.png") });
	});
}

if (failures.length > 0) {
	console.log(`\n${failures.length} FAIL: ${failures.join("; ")}`);
	process.exit(1);
}
console.log("\nall checks passed");
