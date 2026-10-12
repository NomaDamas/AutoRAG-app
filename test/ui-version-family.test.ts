import { describe, expect, it } from "vitest";
import type { FinderEntry } from "../src/renderer/src/data/entries";
import {
	applyVersionStacks,
	buildVersionFamilies,
	defaultIndexIncluded,
	EMPTY_VERSION_FAMILIES,
	stackSelectionKeys,
	type VersionFamilyData,
} from "../src/renderer/src/state/version-family";

function entry(path: string, name = path.split("/").pop() ?? ""): FinderEntry {
	return {
		name,
		path,
		kind: "file",
		ext: "xlsx",
		size: 86016,
		mtimeMs: 0,
		birthtimeMs: 0,
		osKind: "Excel Spreadsheet",
	};
}

const HEAD = "Documents/Finance/2026 Q3/Q3_마케팅예산_v3.xlsx";
const SAME_FOLDER_MEMBER = "Documents/Finance/2026 Q3/Q3_마케팅예산_v2.xlsx";
const CROSS_FOLDER_MEMBER = "Downloads/Q3_마케팅예산_v3 (1).xlsx";

function families(): VersionFamilyData[] {
	return [
		{
			head: HEAD,
			members: [
				{ path: SAME_FOLDER_MEMBER, relation: "near" },
				{ path: CROSS_FOLDER_MEMBER, relation: "exact" },
			],
			entriesByPath: {
				[HEAD]: entry(HEAD),
				[SAME_FOLDER_MEMBER]: entry(SAME_FOLDER_MEMBER),
				[CROSS_FOLDER_MEMBER]: entry(CROSS_FOLDER_MEMBER),
			},
		},
	];
}

describe("applyVersionStacks", () => {
	it("passes rows through when there are no families", () => {
		const rows = [entry(HEAD)];
		const out = applyVersionStacks(rows, {
			families: EMPTY_VERSION_FAMILIES,
			manualOpen: new Set(),
			selectedKeys: [],
		});
		expect(out).toEqual([{ entry: rows[0], stackCount: 0, stackOpen: false, child: false, relation: null }]);
	});

	it("hides same-folder members from the flat list", () => {
		const out = applyVersionStacks([entry(HEAD), entry(SAME_FOLDER_MEMBER)], {
			families: buildVersionFamilies(families()),
			manualOpen: new Set(),
			selectedKeys: [],
		});
		expect(out.map((row) => row.entry.path)).toEqual([HEAD]);
	});

	it("keeps cross-folder members as their own flat rows", () => {
		const out = applyVersionStacks([entry(CROSS_FOLDER_MEMBER)], {
			families: buildVersionFamilies(families()),
			manualOpen: new Set(),
			selectedKeys: [],
		});
		expect(out.map((row) => row.entry.path)).toEqual([CROSS_FOLDER_MEMBER]);
		expect(out[0]?.child).toBe(false);
	});

	it("counts members on the head and expands on selection", () => {
		const out = applyVersionStacks([entry(HEAD)], {
			families: buildVersionFamilies(families()),
			manualOpen: new Set(),
			selectedKeys: [HEAD],
		});
		expect(out[0]?.stackCount).toBe(2);
		expect(out[0]?.stackOpen).toBe(true);
		expect(out.map((row) => row.entry.path)).toEqual([HEAD, SAME_FOLDER_MEMBER, CROSS_FOLDER_MEMBER]);
		expect(out[1]?.child).toBe(true);
		expect(out[1]?.relation).toBe("near");
		expect(out[2]?.relation).toBe("exact");
	});

	it("auto-expands when a member is selected", () => {
		const out = applyVersionStacks([entry(HEAD)], {
			families: buildVersionFamilies(families()),
			manualOpen: new Set(),
			selectedKeys: [CROSS_FOLDER_MEMBER],
		});
		expect(out[0]?.stackOpen).toBe(true);
	});

	it("expands through the manual pin", () => {
		const out = applyVersionStacks([entry(HEAD)], {
			families: buildVersionFamilies(families()),
			manualOpen: new Set([HEAD]),
			selectedKeys: [],
		});
		expect(out[0]?.stackOpen).toBe(true);
	});

	it("shows a same-folder member as a row when its head is not listed", () => {
		const out = applyVersionStacks([entry(SAME_FOLDER_MEMBER)], {
			families: buildVersionFamilies(families()),
			manualOpen: new Set(),
			selectedKeys: [],
		});
		expect(out.map((row) => row.entry.path)).toEqual([SAME_FOLDER_MEMBER]);
		expect(out[0]?.child).toBe(false);
		expect(out[0]?.stackCount).toBe(0);
	});

	it("stackCount equals emitted child rows", () => {
		const out = applyVersionStacks([entry(HEAD)], {
			families: buildVersionFamilies(families()),
			manualOpen: new Set(),
			selectedKeys: [HEAD],
		});
		// Two members with entries → stackCount should be 2
		expect(out[0]?.stackCount).toBe(2);
		expect(out.length).toBe(3); // head + 2 child rows
		expect(out.filter((r) => r.child).length).toBe(out[0]?.stackCount);
	});

	it("stays closed when nothing selects or pins it", () => {
		const out = applyVersionStacks([entry(HEAD)], {
			families: buildVersionFamilies(families()),
			manualOpen: new Set(),
			selectedKeys: [],
		});
		expect(out[0]?.stackOpen).toBe(false);
		expect(out.map((row) => row.entry.path)).toEqual([HEAD]);
	});
});

describe("stackCount matches children", () => {
	it("stackCount equals the number of child rows when open", () => {
		// Use a family where one member has no entry (filtered out)
		const partialFamilies: VersionFamilyData[] = [
			{
				head: HEAD,
				members: [
					{ path: SAME_FOLDER_MEMBER, relation: "near" },
					{ path: CROSS_FOLDER_MEMBER, relation: "exact" },
				],
				// Only one member has an entry
				entriesByPath: {
					[HEAD]: entry(HEAD),
					[SAME_FOLDER_MEMBER]: entry(SAME_FOLDER_MEMBER),
				},
			},
		];
		const out = applyVersionStacks([entry(HEAD)], {
			families: buildVersionFamilies(partialFamilies),
			manualOpen: new Set(),
			selectedKeys: [HEAD],
		});
		expect(out[0]?.stackCount).toBe(1);
		expect(out.length).toBe(2); // head + 1 child
		expect(out.filter((r) => r.child).length).toBe(out[0]?.stackCount);
	});
});

describe("defaultIndexIncluded", () => {
	it("excludes stack members by default", () => {
		const built = buildVersionFamilies(families());
		expect(defaultIndexIncluded(SAME_FOLDER_MEMBER, built)).toBe(false);
		expect(defaultIndexIncluded(CROSS_FOLDER_MEMBER, built)).toBe(false);
		expect(defaultIndexIncluded(HEAD, built)).toBe(true);
		expect(defaultIndexIncluded("Documents/other.txt", built)).toBe(true);
	});
});
describe("stackSelectionKeys", () => {
	it("keeps only selected heads and members, so selecting a plain row opens and re-sorts nothing", () => {
		const built = buildVersionFamilies(families());
		expect(stackSelectionKeys(["Documents/other.txt"], built)).toEqual([]);
		expect(stackSelectionKeys(["Documents/other.txt", CROSS_FOLDER_MEMBER], built)).toEqual([CROSS_FOLDER_MEMBER]);
		expect(stackSelectionKeys([HEAD], EMPTY_VERSION_FAMILIES)).toEqual([]);
	});

	it("opens the same stacks as the full selection", () => {
		const built = buildVersionFamilies(families());
		const rows = [entry(HEAD), entry(SAME_FOLDER_MEMBER), entry("Documents/Finance/2026 Q3/other.xlsx")];
		const selection = ["Documents/Finance/2026 Q3/other.xlsx", SAME_FOLDER_MEMBER];
		const options = { families: built, manualOpen: new Set<string>() };
		expect(applyVersionStacks(rows, { ...options, selectedKeys: stackSelectionKeys(selection, built) })).toEqual(
			applyVersionStacks(rows, { ...options, selectedKeys: selection }),
		);
	});
});
