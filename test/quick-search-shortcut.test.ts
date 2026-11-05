import { describe, expect, it } from "vitest";
import { createQuickSearchShortcut } from "../src/main/quick-search-shortcut";

function fakeOs(taken: readonly string[] = []) {
	const registered = new Map<string, () => void>();
	return {
		registered,
		register: (accelerator: string, callback: () => void) => {
			if (taken.includes(accelerator) || registered.has(accelerator)) return false;
			registered.set(accelerator, callback);
			return true;
		},
		unregister: (accelerator: string) => {
			registered.delete(accelerator);
		},
	};
}

describe("quick search global shortcut", () => {
	it("registers the configured chord and summons the launcher when it fires", () => {
		const os = fakeOs();
		let summoned = 0;
		const shortcut = createQuickSearchShortcut({ ...os, onPress: () => (summoned += 1) });

		shortcut.apply({ enabled: true, chord: "Alt+Space" });
		os.registered.get("Alt+Space")?.();

		expect([...os.registered.keys()]).toEqual(["Alt+Space"]);
		expect(summoned).toBe(1);
		expect(shortcut.status()).toEqual({ registered: true, error: null });
	});

	it("moves to a new chord, releasing the old one, and releases everything when turned off", () => {
		const os = fakeOs();
		const shortcut = createQuickSearchShortcut({ ...os, onPress: () => {} });
		shortcut.apply({ enabled: true, chord: "Alt+Space" });

		shortcut.apply({ enabled: true, chord: "Mod+Shift+K" });
		expect([...os.registered.keys()]).toEqual(["CommandOrControl+Shift+K"]);

		shortcut.apply({ enabled: false, chord: "Mod+Shift+K" });
		expect(os.registered.size).toBe(0);
		expect(shortcut.status()).toEqual({ registered: false, error: null });
	});

	it("reports a chord another app holds instead of pretending it works, and recovers on the next choice", () => {
		const os = fakeOs(["Alt+Space"]);
		const shortcut = createQuickSearchShortcut({ ...os, onPress: () => {} });

		shortcut.apply({ enabled: true, chord: "Alt+Space" });
		expect(shortcut.status()).toEqual({ registered: false, error: "taken" });

		shortcut.apply({ enabled: true, chord: "Mod+Alt+Space" });
		expect(shortcut.status()).toEqual({ registered: true, error: null });
	});

	it("lets go of the chord while Settings records a new one, then takes it back", () => {
		const os = fakeOs();
		const shortcut = createQuickSearchShortcut({ ...os, onPress: () => {} });
		shortcut.apply({ enabled: true, chord: "Alt+Space" });

		shortcut.setPaused(true);
		expect(os.registered.size).toBe(0);
		// A settings change while paused is remembered, not registered yet.
		shortcut.apply({ enabled: true, chord: "Mod+Shift+L" });
		expect(os.registered.size).toBe(0);

		shortcut.setPaused(false);
		expect([...os.registered.keys()]).toEqual(["CommandOrControl+Shift+L"]);
	});

	it("does not re-register an unchanged chord on every settings change", () => {
		const os = fakeOs();
		let registrations = 0;
		const shortcut = createQuickSearchShortcut({
			register: (accelerator, callback) => {
				registrations += 1;
				return os.register(accelerator, callback);
			},
			unregister: os.unregister,
			onPress: () => {},
		});
		shortcut.apply({ enabled: true, chord: "Alt+Space" });
		shortcut.apply({ enabled: true, chord: "Alt+Space" });
		expect(registrations).toBe(1);
	});

	it("dispose releases the chord", () => {
		const os = fakeOs();
		const shortcut = createQuickSearchShortcut({ ...os, onPress: () => {} });
		shortcut.apply({ enabled: true, chord: "Alt+Space" });
		shortcut.dispose();
		expect(os.registered.size).toBe(0);
	});
});
