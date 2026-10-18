import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "node_modules");

/** Installed copies of `name` (a scoped package) in `modules` and in every nested node_modules below it. */
function copiesOf(name: string, modules = root): string[] {
	const found = existsSync(join(modules, name)) ? [join(modules, name)] : [];
	for (const entry of readdirSync(modules, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const packages = entry.name.startsWith("@") ? readdirSync(join(modules, entry.name)).map((child) => join(modules, entry.name, child)) : [join(modules, entry.name)];
		for (const directory of packages) {
			const nested = join(directory, "node_modules");
			if (existsSync(nested)) found.push(...copiesOf(name, nested));
		}
	}
	return found;
}

describe("pi runtime", () => {
	// Module state (the provider registry) is per copy: a second copy of pi-ai means a provider
	// registered through the app is invisible to the librarian (AutoRAG-app#225).
	it.each(["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core"])("installs %s once", (name) => {
		expect(copiesOf(name).map((copy) => relative(root, copy))).toEqual([name]);
	});
});
