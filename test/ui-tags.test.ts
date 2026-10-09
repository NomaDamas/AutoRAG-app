import { describe, expect, it } from "vitest";
import { navGroups, TAGS_GROUP_LABEL } from "../src/renderer/src/data/places";
import { buildContextMenu, estimateMenuHeight, type ContextMenuInput, type FinderMenuSubmenu } from "../src/renderer/src/state/context-menu";
import { emptyStateText } from "../src/renderer/src/state/format";
import { sharedTags, sidebarTags, tagColorsOf, tagDotsOf } from "../src/renderer/src/state/tags";
import { tabTitle } from "../src/renderer/src/state/tabs";
import { breadcrumbTrail } from "../src/renderer/src/state/paths";
import { NO_CAPABILITIES } from "../src/shared/actions-contract";
import { isTagPath, isVirtualListing, RECENTS_PATH, tagNameOf, tagPath, type FsFinderMetadata, type FsTagCatalog } from "../src/shared/fs-contract";

const COLOR_NAMES = ["None", "Gray", "Green", "Purple", "Blue", "Yellow", "Red", "Orange"];

const CATALOG: FsTagCatalog = {
	supported: true,
	colorNames: COLOR_NAMES,
	tags: [
		{ name: "Research", color: 6, sidebar: true },
		{ name: "Career", color: 7, sidebar: true },
		{ name: "Work", color: 0, sidebar: false },
		{ name: "Red", color: 6, sidebar: false },
		{ name: "Orange", color: 7, sidebar: false },
		{ name: "Yellow", color: 5, sidebar: false },
		{ name: "Green", color: 2, sidebar: false },
		{ name: "Blue", color: 4, sidebar: false },
		{ name: "Purple", color: 3, sidebar: false },
		{ name: "Gray", color: 1, sidebar: false },
	],
};

function finder(tags: readonly string[], tagColors?: FsFinderMetadata["tagColors"]): FsFinderMetadata {
	return {
		createdAt: null,
		addedAt: null,
		lastOpenedAt: null,
		tags,
		...(tagColors === undefined ? {} : { tagColors }),
		comments: null,
		width: null,
		height: null,
		rating: null,
		application: null,
	};
}

const file: ContextMenuInput = {
	target: { name: "a.pdf", kind: "file" },
	selectionCount: 1,
	indexIncluded: true,
	clipboardCount: 0,
	capabilities: NO_CAPABILITIES,
	canCreateFolder: true,
};

describe("tag locations", () => {
	it("round-trips a tag name, spaces and slashes included", () => {
		for (const name of ["Research", "Important things", "a/b", "한글 태그"]) {
			expect(tagNameOf(tagPath(name))).toBe(name);
			expect(isTagPath(tagPath(name))).toBe(true);
		}
	});

	it("never mistakes a real folder for a tag, nor an empty tag for one", () => {
		expect(isTagPath("/Users/me/tag://x")).toBe(false);
		expect(isTagPath("tag://")).toBe(false);
		expect(tagNameOf("/Users/me")).toBe("");
	});

	it("treats Recents and tags as listings that are not a folder to write into", () => {
		expect(isVirtualListing(RECENTS_PATH)).toBe(true);
		expect(isVirtualListing(tagPath("Research"))).toBe(true);
		expect(isVirtualListing("/Users/me/Documents")).toBe(false);
	});

	it("titles a tag tab with the tag's name and words its empty state", () => {
		expect(tabTitle({ path: tagPath("Research") }, { isActive: false, query: "" })).toBe("Research");
		expect(emptyStateText("", tagPath("Work"))).toBe('"Work" 태그가 붙은 항목이 없습니다');
	});

	it("shows a tag as one crumb, never as a folder path", () => {
		expect(breadcrumbTrail(tagPath("Important things"), Number.MAX_SAFE_INTEGER)).toEqual([
			{ label: "Important things", path: "tag://Important things", separator: false, isLast: true },
		]);
	});
});

describe("the sidebar Tags group", () => {
	it("lists only the tags Finder shows in its own sidebar, after the OS sections", () => {
		const groups = navGroups([], sidebarTags(CATALOG));
		const tags = groups.find((group) => group.label === TAGS_GROUP_LABEL);
		expect(tags?.items.map((item) => [item.label, item.path, item.tag?.color])).toEqual([
			["Research", "tag://Research", 6],
			["Career", "tag://Career", 7],
		]);
		expect(groups[groups.length - 1]?.label).toBe(TAGS_GROUP_LABEL);
	});

	it("has no Tags group where the platform has no tags", () => {
		const off: FsTagCatalog = { supported: false, tags: [], colorNames: [] };
		expect(navGroups([], sidebarTags(off)).map((group) => group.label)).not.toContain(TAGS_GROUP_LABEL);
	});
});

describe("row dots", () => {
	const colors = tagColorsOf(CATALOG);

	it("draws the registry's colour, not the one the file stored", () => {
		// The file stored Career as gray (1); Finder's registry now says orange (7).
		expect(tagDotsOf(finder(["Career"], [1]), colors)).toEqual([{ name: "Career", color: 7 }]);
	});

	it("falls back to the stored colour for a tag the registry has never heard of", () => {
		expect(tagDotsOf(finder(["Unknown"], [4]), colors)).toEqual([{ name: "Unknown", color: 4 }]);
		expect(tagDotsOf(finder(["Unknown"]), colors)).toEqual([{ name: "Unknown", color: 0 }]);
	});

	it("matches names case-insensitively and keeps the file's tag order", () => {
		expect(tagDotsOf(finder(["work", "RESEARCH"]), colors).map((dot) => [dot.name, dot.color])).toEqual([
			["work", 0],
			["RESEARCH", 6],
		]);
	});

	it("draws nothing for an untagged row or before the metadata pass answered", () => {
		expect(tagDotsOf(finder([]), colors)).toEqual([]);
		expect(tagDotsOf(undefined, colors)).toEqual([]);
	});

	it("reports only the tags every selected row carries", () => {
		const shared = sharedTags([finder(["Research", "Work"]), finder(["research"]), finder(["Research", "Career"])]);
		expect([...shared]).toEqual(["research"]);
		expect(sharedTags([finder(["Research"]), undefined]).size).toBe(0);
		expect(sharedTags([]).size).toBe(0);
	});
});

describe("the row context menu's tag block", () => {
	const withTags = (shared: string[], extra: Partial<ContextMenuInput> = {}) =>
		buildContextMenu({ ...file, tags: { catalog: CATALOG, shared: new Set(shared) }, ...extra });

	it("offers the seven colour dots in Finder's order, ticking the ones the whole selection carries", () => {
		const row = withTags(["red"]).find((entry) => entry.kind === "tags");
		expect(row?.kind === "tags" && row.swatches.map((swatch) => swatch.name)).toEqual(["Red", "Orange", "Yellow", "Green", "Blue", "Purple", "Gray"]);
		expect(row?.kind === "tags" && row.swatches.filter((swatch) => swatch.checked).map((swatch) => swatch.name)).toEqual(["Red"]);
	});

	it("lists every Finder tag in a submenu, ticked when shared", () => {
		const submenu = withTags(["research"]).find((entry): entry is FinderMenuSubmenu => entry.kind === "submenu");
		const leaves = submenu?.items.flatMap((leaf) => (leaf.kind === "submenu-item" ? [leaf] : [])) ?? [];
		expect(leaves.map((leaf) => leaf.tagName)).toContain("Research");
		expect(leaves.find((leaf) => leaf.tagName === "Research")?.checked).toBe(true);
		expect(leaves.find((leaf) => leaf.tagName === "Career")?.checked).toBe(false);
		expect(leaves.every((leaf) => leaf.action === "toggleTag")).toBe(true);
	});

	it("leaves the tag block out off macOS, in the Trash, and when the caller passes none", () => {
		const off: FsTagCatalog = { supported: false, tags: [], colorNames: [] };
		const hasTags = (entries: ReturnType<typeof buildContextMenu>): boolean => entries.some((entry) => entry.kind === "tags");
		expect(hasTags(buildContextMenu({ ...file, tags: { catalog: off, shared: new Set() } }))).toBe(false);
		expect(hasTags(withTags([], { inTrash: true }))).toBe(false);
		expect(hasTags(buildContextMenu(file))).toBe(false);
	});

	it("sizes the menu for the swatch row so the menu never clips at the screen edge", () => {
		const plain = estimateMenuHeight(buildContextMenu(file));
		const tagged = estimateMenuHeight(withTags([]));
		expect(tagged).toBeGreaterThan(plain + 28);
	});
});
