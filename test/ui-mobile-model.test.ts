import { describe, expect, it } from "vitest";
import type { MagicAction } from "../src/shared/context-menu-contract";
import type { FinderEntry } from "../src/renderer/src/data/entries";
import {
	INITIAL_STACKS,
	ancestorPaths,
	groupRecents,
	itemMenu,
	mobileListing,
	nextSort,
	popRoute,
	popToRoot,
	pushRoute,
	recentsBucket,
	revealStack,
	splitName,
	toolItems,
	wantsMobileShell,
	isPhoneUserAgent,
} from "../src/renderer/src/mobile/model";

const file = (name: string, extra: Partial<FinderEntry> = {}): FinderEntry => ({
	name,
	path: `/Users/me/${name}`,
	kind: "file",
	ext: name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "",
	size: 10,
	mtimeMs: 0,
	birthtimeMs: 0,
	...extra,
});
const folder = (name: string, extra: Partial<FinderEntry> = {}): FinderEntry => ({ ...file(name, extra), kind: "folder", ext: "", size: null });

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

describe("wantsMobileShell", () => {
	const phone = { remote: true, width: 393, height: 852, coarse: true, phoneAgent: true };

	it("never takes over the desktop window, even at phone width", () => {
		expect(wantsMobileShell({ ...phone, remote: false })).toBe(false);
	});

	it("takes a phone in portrait and keeps it when rotated", () => {
		expect(wantsMobileShell(phone)).toBe(true);
		expect(wantsMobileShell({ ...phone, width: 852, height: 393 })).toBe(true);
	});

	it("leaves a tablet and a wide desktop browser on the desktop layout", () => {
		expect(wantsMobileShell({ remote: true, width: 820, height: 1180, coarse: true, phoneAgent: false })).toBe(false);
		expect(wantsMobileShell({ remote: true, width: 1440, height: 900, coarse: false, phoneAgent: false })).toBe(false);
	});

	it("gives a desktop browser narrowed to phone width the phone layout", () => {
		expect(wantsMobileShell({ remote: true, width: 420, height: 900, coarse: false, phoneAgent: false })).toBe(true);
		expect(wantsMobileShell({ remote: true, width: 501, height: 900, coarse: false, phoneAgent: false })).toBe(false);
	});
});

describe("isPhoneUserAgent", () => {
	it("trusts userAgentData when the browser reports it", () => {
		expect(isPhoneUserAgent(DESKTOP, true)).toBe(true);
		expect(isPhoneUserAgent(IPHONE, false)).toBe(false);
	});

	it("tells phones from tablets and desktops by the agent string", () => {
		expect(isPhoneUserAgent(IPHONE, undefined)).toBe(true);
		expect(isPhoneUserAgent("Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari/537.36", undefined)).toBe(true);
		expect(isPhoneUserAgent(IPAD, undefined)).toBe(false);
		expect(isPhoneUserAgent(DESKTOP, undefined)).toBe(false);
	});
});

describe("mobileListing", () => {
	it("lists folders first, then the chosen order, and hides dotfiles unless asked", () => {
		const entries = [file("b.txt", { mtimeMs: 1 }), folder("Zeta"), file(".env"), file("a.txt", { mtimeMs: 2 }), folder("alpha")];
		expect(mobileListing(entries, { key: "name", ascending: true }, false).map((entry) => entry.name)).toEqual(["alpha", "Zeta", "a.txt", "b.txt"]);
		expect(mobileListing(entries, { key: "date", ascending: false }, true).map((entry) => entry.name).slice(2)).toEqual(["a.txt", "b.txt", ".env"]);
	});

	it("flips the direction on the same key and starts a new key in its natural direction", () => {
		expect(nextSort({ key: "name", ascending: true }, "name")).toEqual({ key: "name", ascending: false });
		expect(nextSort({ key: "name", ascending: true }, "date")).toEqual({ key: "date", ascending: false });
		expect(nextSort({ key: "date", ascending: false }, "kind")).toEqual({ key: "kind", ascending: true });
	});
});

describe("splitName", () => {
	it("keeps the end of a long name and its extension out of the ellipsis", () => {
		expect(splitName("ktwiz 앰프 박경수 응원가 부활.mp3", false)).toEqual({ head: "ktwiz 앰프 박경수 응원", tail: "가 부활.mp3" });
	});

	it("leaves short names, folders and extensionless names whole", () => {
		expect(splitName("a.txt", false).tail).toBe("");
		expect(splitName("A very long folder name.v2", true).tail).toBe("");
		expect(splitName("Makefile-without-extension", false).tail).toBe("");
	});
});

describe("Recents", () => {
	const now = new Date(2026, 10, 3, 0, 1).getTime();

	it("buckets by local calendar day, not by 24-hour windows", () => {
		expect(recentsBucket(new Date(2026, 10, 2, 23, 59).getTime(), now)).toBe("yesterday");
		expect(recentsBucket(new Date(2026, 10, 3, 0, 0).getTime(), now)).toBe("today");
		expect(recentsBucket(new Date(2026, 9, 28).getTime(), now)).toBe("week");
		expect(recentsBucket(new Date(2026, 9, 10).getTime(), now)).toBe("month");
		expect(recentsBucket(new Date(2025, 0, 1).getTime(), now)).toBe("older");
	});

	it("groups newest first and leaves empty buckets out", () => {
		const groups = groupRecents([file("old", { mtimeMs: new Date(2025, 0, 1).getTime() }), file("new", { mtimeMs: now })], now);
		expect(groups.map((group) => [group.bucket, group.entries.map((entry) => entry.name)])).toEqual([["today", ["new"]], ["older", ["old"]]]);
	});
});

describe("itemMenu", () => {
	const base = { inTrash: false, outsideFolder: false, allIndexed: false, magicActions: [] as MagicAction[], archive: true, tags: true };
	const pdfAction: MagicAction = { id: "pdf", label: "PDF 요약", enabled: true, selection: "single", targetKind: "file", extensions: ["pdf"], execution: { kind: "agent", mode: "read", prompt: "x" } };

	it("offers only restore in the Trash", () => {
		expect(itemMenu({ ...base, entries: [file("a.pdf")], inTrash: true })).toEqual({ quick: false, items: ["restore"], magic: [], indexIncludes: false });
	});

	it("drops single-target rows for a multi-selection and previews only files", () => {
		expect(itemMenu({ ...base, entries: [folder("Docs")] }).items).not.toContain("quickLook");
		const many = itemMenu({ ...base, entries: [file("a.txt"), file("b.txt")] }).items;
		expect(many).not.toContain("info");
		expect(many).not.toContain("rename");
	});

	it("offers 상위 폴더에서 보기 only outside a folder listing", () => {
		expect(itemMenu({ ...base, entries: [file("a.txt")] }).items).not.toContain("reveal");
		expect(itemMenu({ ...base, entries: [file("a.txt")], outsideFolder: true }).items).toContain("reveal");
	});

	it("shows magic actions that match the targets", () => {
		expect(itemMenu({ ...base, entries: [file("a.pdf")], magicActions: [pdfAction] }).magic.map((action) => action.id)).toEqual(["pdf"]);
		const mp3 = itemMenu({ ...base, entries: [file("a.mp3")], magicActions: [pdfAction] });
		expect(mp3.items).not.toContain("magic");
	});

	it("hides tags where the host has no Finder tags", () => {
		expect(itemMenu({ ...base, entries: [file("a.txt")], tags: false }).items).not.toContain("tags");
	});

	it("includes or excludes from the index depending on what the targets are", () => {
		expect(itemMenu({ ...base, entries: [file("a.txt")], allIndexed: true }).indexIncludes).toBe(false);
		expect(itemMenu({ ...base, entries: [file("a.txt")] }).indexIncludes).toBe(true);
	});
});

describe("toolItems", () => {
	it("offers extract only for one zip, and archive work only where the host can run it", () => {
		expect(toolItems([file("a.zip")], true)).toEqual(["compress", "extract", "index", "duplicate"]);
		expect(toolItems([file("a.zip"), file("b.zip")], true)).toEqual(["compress", "index", "duplicate"]);
		expect(toolItems([file("a.zip")], false)).toEqual(["index", "duplicate"]);
	});
});

describe("navigation stacks", () => {
	it("pushes and pops per tab, never popping the root", () => {
		const pushed = pushRoute(INITIAL_STACKS, "browse", { kind: "folder", path: "/a" });
		expect(pushed.browse).toHaveLength(2);
		expect(pushed.settings).toBe(INITIAL_STACKS.settings);
		expect(popRoute(popRoute(pushed, "browse"), "browse").browse).toEqual(INITIAL_STACKS.browse);
	});

	it("returns to the root when the current tab is tapped again", () => {
		const deep = pushRoute(pushRoute(INITIAL_STACKS, "browse", { kind: "folder", path: "/a" }), "browse", { kind: "folder", path: "/a/b" });
		expect(popToRoot(deep, "browse").browse).toEqual(INITIAL_STACKS.browse);
	});

	it("reveals a folder with one route per ancestor so back walks up the tree", () => {
		expect(ancestorPaths("C:\\Users\\me\\x")).toEqual(["C:\\", "C:\\Users", "C:\\Users\\me"]);
		expect(ancestorPaths("/Users/me/x")).toEqual(["/", "/Users", "/Users/me"]);
		expect(ancestorPaths("/")).toEqual([]);
		expect(revealStack("/a/b", ancestorPaths("/a/b"))).toEqual([
			{ kind: "places" },
			{ kind: "folder", path: "/" },
			{ kind: "folder", path: "/a" },
			{ kind: "folder", path: "/a/b" },
		]);
	});
});
