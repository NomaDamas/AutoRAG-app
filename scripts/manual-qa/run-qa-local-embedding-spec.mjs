// The local-embedding spec guard in the real built app, on machines the lane
// pretends to be (AUTORAG_QA_HARDWARE, honored only by unpackaged builds) and on
// the machine it actually runs on.
//
//   bun scripts/manual-qa/run-qa-local-embedding-spec.mjs            # every pretend machine, then this one
//   bun scripts/manual-qa/run-qa-local-embedding-spec.mjs real       # only this machine
//
// Dense embedding is opt-in now: the zero-question first run is keyword-only, so
// the old onboarding embedding card is gone and the only place the spec is shown
// is Settings → AI Models → document understanding. Per machine the lane checks
// that picker: the four profiles, the local one marked available or unavailable,
// the reason on it, and that choosing it does not select it. Screenshots go to
// .omo/evidence/local-embedding-spec/.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
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

async function withApp({ hardware, language }, run) {
	const work = mkdtempSync(join(tmpdir(), "autorag-qa-localspec-"));
	const userDataDir = join(work, "user-data");
	const configPath = join(work, "config.json");
	writeFileSync(configPath, `${JSON.stringify({ searchPaths: [work], workspacePath: work, memoryPath: join(work, "memory.json") }, null, 2)}\n`);
	const env = {
		AUTORAG_HOME: work,
		AUTORAG_CONFIG: configPath,
		AUTORAG_SKIP_DUPEY_CHECK: "1",
		...(hardware === null ? {} : { AUTORAG_QA_HARDWARE: JSON.stringify(hardware) }),
	};
	const app = await launchFinder({ userDataDir, env, language });
	try {
		const page = await finderWindow(app, 20_000);
		return await run(page, { work, configPath });
	} finally {
		await app.close().catch(() => undefined);
		rmRetry(work);
	}
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
		await withApp({ hardware: machine.hardware, language: "en" }, async (page) => {
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
}

if (only === undefined || only === "real") {
	console.log("\n=== this machine, no override ===");
	await withApp({ hardware: null, language: "en" }, async (page) => {
		const rows = await settingsPicker(page);
		const local = rows[1];
		console.log(`INFO cpu: ${cpus()[0]?.model} ; local profile: ${JSON.stringify(local)}`);
		check("the local profile is offered in Settings", rows.length === 4 && local !== undefined, String(rows.length));
		if (local?.disabled === true) check("a disabled local profile shows a reason", local.text.trim().length > 0, local.text);
		await page.locator(".settings-modal, [role='dialog']").first().screenshot({ path: join(EVIDENCE, "settings-this-machine.png") }).catch(() => undefined);
	});
}

if (failures.length > 0) {
	console.log(`\n${failures.length} FAIL: ${failures.join("; ")}`);
	process.exit(1);
}
console.log("\nall checks passed");
