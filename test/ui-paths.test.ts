import { describe, expect, it } from "vitest";
import {
	activeNavPath,
	basename,
	breadcrumbTrail,
	dirname,
	isAbsolutePath,
	joinPath,
	pathSegments,
	resolvePathInput,
	volumeLabel,
	whereSegments,
} from "../src/renderer/src/state/paths";

describe("path helpers", () => {
	it("splits relative and absolute paths", () => {
		expect(pathSegments("Documents/Finance/2026 Q3")).toEqual(["Documents", "Finance", "2026 Q3"]);
		expect(pathSegments("/Users/jeffrey/Documents")).toEqual(["Users", "jeffrey", "Documents"]);
		expect(pathSegments("")).toEqual([]);
	});

	it("reads the last segment", () => {
		expect(basename("Documents/Finance")).toBe("Finance");
		expect(basename("/Users/jeffrey/a.pdf")).toBe("a.pdf");
		expect(basename("Desktop")).toBe("Desktop");
	});

	it("reads the parent directory", () => {
		expect(dirname("Documents/Finance/a.pdf")).toBe("Documents/Finance");
		expect(dirname("/Users/jeffrey/a.pdf")).toBe("/Users/jeffrey");
		expect(dirname("Desktop")).toBe("");
		expect(dirname("/a.pdf")).toBe("/");
	});

	it("joins a directory and a name", () => {
		expect(joinPath("Documents", "a.pdf")).toBe("Documents/a.pdf");
		expect(joinPath("/Users/jeffrey", "a.pdf")).toBe("/Users/jeffrey/a.pdf");
		expect(joinPath("/", "a.pdf")).toBe("/a.pdf");
		expect(joinPath("", "Desktop")).toBe("Desktop");
	});

	it("renders the Where column with the reference separator", () => {
		expect(whereSegments("Documents/Finance/2026 Q3")).toBe("Documents › Finance › 2026 Q3");
	});
});

describe("breadcrumbTrail", () => {
	it("shows a single segment with no separator", () => {
		expect(breadcrumbTrail("Desktop")).toEqual([
			{ label: "Desktop", path: "Desktop", separator: false, isLast: true },
		]);
	});

	it("shows two segments with one separator", () => {
		expect(breadcrumbTrail("Documents/Finance")).toEqual([
			{ label: "Documents", path: "Documents", separator: false, isLast: false },
			{ label: "Finance", path: "Documents/Finance", separator: true, isLast: true },
		]);
	});

	it("keeps the last two segments and prefixes an ellipsis crumb", () => {
		expect(breadcrumbTrail("Documents/Finance/2026 Q3/벤더 견적")).toEqual([
			{ label: "…", path: "Documents/Finance", separator: false, isLast: false },
			{ label: "2026 Q3", path: "Documents/Finance/2026 Q3", separator: true, isLast: false },
			{ label: "벤더 견적", path: "Documents/Finance/2026 Q3/벤더 견적", separator: true, isLast: true },
		]);
	});

	it("keeps absolute crumb paths navigable", () => {
		const trail = breadcrumbTrail("/Users/jeffrey/Documents/Finance");
		expect(trail.map((c) => c.path)).toEqual([
			"/Users/jeffrey",
			"/Users/jeffrey/Documents",
			"/Users/jeffrey/Documents/Finance",
		]);
		expect(trail[0]?.label).toBe("…");
	});

	it("returns nothing for an empty path", () => {
		expect(breadcrumbTrail("")).toEqual([]);
	});
});

describe("activeNavPath", () => {
	const nav = [
		{ name: "Recents", path: "Recents" },
		{ name: "Documents", path: "/Users/jeffrey/Documents" },
		{ name: "Desktop", path: "/Users/jeffrey/Desktop" },
	];

	it("matches the nav entry that owns the current path", () => {
		expect(activeNavPath("/Users/jeffrey/Documents/Finance", nav)).toBe("/Users/jeffrey/Documents");
		expect(activeNavPath("Recents", nav)).toBe("Recents");
	});

	it("prefers the longest matching entry", () => {
		const nested = [
			{ name: "Home", path: "/Users/jeffrey" },
			{ name: "Documents", path: "/Users/jeffrey/Documents" },
		];
		expect(activeNavPath("/Users/jeffrey/Documents/Finance", nested)).toBe("/Users/jeffrey/Documents");
	});

	it("does not match a partial segment", () => {
		expect(activeNavPath("/Users/jeffrey/Documents-old", nav)).toBeNull();
	});

	it("returns null when nothing matches", () => {
		expect(activeNavPath("Slack/#general", nav)).toBeNull();
	});
});

describe("path helpers on Windows paths", () => {
	it("splits drive, backslash, and UNC paths", () => {
		expect(pathSegments("C:\\Users\\me\\Documents")).toEqual(["C:", "Users", "me", "Documents"]);
		expect(pathSegments("C:/Users/me")).toEqual(["C:", "Users", "me"]);
		expect(pathSegments("\\\\server\\share\\folder")).toEqual(["server", "share", "folder"]);
	});

	it("treats drive, UNC, and posix roots as absolute", () => {
		expect(isAbsolutePath("C:\\Users\\me")).toBe(true);
		expect(isAbsolutePath("C:/Users/me")).toBe(true);
		expect(isAbsolutePath("\\\\server\\share\\folder")).toBe(true);
		expect(isAbsolutePath("/Users/jeffrey")).toBe(true);
		expect(isAbsolutePath("Documents/Finance")).toBe(false);
		expect(isAbsolutePath("C:Users")).toBe(false);
	});

	it("reads the last segment of a Windows path", () => {
		expect(basename("C:\\Users\\me\\a.pdf")).toBe("a.pdf");
		expect(basename("C:\\Users\\me")).toBe("me");
	});

	it("reads the parent of a Windows path, stopping at the drive or share root", () => {
		expect(dirname("C:\\Users\\me\\a.pdf")).toBe("C:\\Users\\me");
		expect(dirname("C:\\Users\\me")).toBe("C:\\Users");
		expect(dirname("C:\\Users")).toBe("C:\\");
		expect(dirname("C:\\a.pdf")).toBe("C:\\");
		expect(dirname("\\\\server\\share\\folder\\a.pdf")).toBe("\\\\server\\share\\folder");
		expect(dirname("\\\\server\\share\\a.pdf")).toBe("\\\\server\\share\\");
	});

	it("joins a Windows directory with the backslash separator", () => {
		expect(joinPath("C:\\Users\\me", "a.pdf")).toBe("C:\\Users\\me\\a.pdf");
		expect(joinPath("C:\\", "a.pdf")).toBe("C:\\a.pdf");
		expect(joinPath("\\\\server\\share", "a.pdf")).toBe("\\\\server\\share\\a.pdf");
	});

	it("keeps Windows crumb paths navigable with backslashes", () => {
		const trail = breadcrumbTrail("C:\\Users\\me\\Documents\\Finance");
		expect(trail.map((crumb) => crumb.label)).toEqual(["…", "Documents", "Finance"]);
		expect(trail.map((crumb) => crumb.path)).toEqual([
			"C:\\Users\\me",
			"C:\\Users\\me\\Documents",
			"C:\\Users\\me\\Documents\\Finance",
		]);
	});

	it("renders the Where column for a Windows path", () => {
		expect(whereSegments("C:\\Users\\me\\Documents")).toBe("C: › Users › me › Documents");
	});
});

describe("activeNavPath on Windows paths", () => {
	const nav = [
		{ name: "Documents", path: "C:\\Users\\me\\Documents" },
		{ name: "Desktop", path: "C:\\Users\\me\\Desktop" },
	];

	it("matches a Windows location by its backslash prefix", () => {
		expect(activeNavPath("C:\\Users\\me\\Documents\\Finance", nav)).toBe("C:\\Users\\me\\Documents");
	});

	it("does not match a partial Windows segment", () => {
		expect(activeNavPath("C:\\Users\\me\\Documents-old", nav)).toBeNull();
	});
});

describe("volumeLabel", () => {
	it("keeps the macOS boot-volume label for POSIX home paths", () => {
		expect(volumeLabel("/Users/jeffrey/Documents")).toBe("Macintosh HD");
	});

	it("derives a Windows drive root instead of the macOS label", () => {
		expect(volumeLabel("C:\\Users\\me")).toBe("C:");
		expect(volumeLabel("C:/Users/me")).toBe("C:");
		expect(volumeLabel("d:\\Users\\me")).toBe("D:");
	});

	it("derives the UNC share prefix for a network path", () => {
		expect(volumeLabel("\\\\server\\share\\Users\\me")).toBe("\\\\server\\share");
	});
});

describe("resolvePathInput", () => {
	const posix = { current: "/Users/jeffrey/Documents", home: "/Users/jeffrey" };

	it("keeps a pasted absolute path, trimmed and without trailing separators", () => {
		expect(resolvePathInput("  /Users/jeffrey/Downloads/  \n", posix)).toBe("/Users/jeffrey/Downloads");
		expect(resolvePathInput("/", posix)).toBe("/");
	});

	it("drops the quotes a shell or 'Copy as Pathname' wraps around a path", () => {
		expect(resolvePathInput('"/Users/jeffrey/My Files"', posix)).toBe("/Users/jeffrey/My Files");
		expect(resolvePathInput("'/tmp/a b'", posix)).toBe("/tmp/a b");
	});

	it("collapses repeated separators and dot segments without leaving the root", () => {
		expect(resolvePathInput("/Users//jeffrey/./Documents/../Desktop", posix)).toBe("/Users/jeffrey/Desktop");
		expect(resolvePathInput("/../..", posix)).toBe("/");
	});

	it("expands ~ to the home folder", () => {
		expect(resolvePathInput("~", posix)).toBe("/Users/jeffrey");
		expect(resolvePathInput("~/Library/Caches", posix)).toBe("/Users/jeffrey/Library/Caches");
	});

	it("rejects ~ when the home folder is unknown", () => {
		expect(resolvePathInput("~/Desktop", { ...posix, home: null })).toBeNull();
	});

	it("resolves a relative path against the folder in view", () => {
		expect(resolvePathInput("Finance/2026", posix)).toBe("/Users/jeffrey/Documents/Finance/2026");
		expect(resolvePathInput("..", posix)).toBe("/Users/jeffrey");
	});

	it("reads a file:// URL as its decoded path", () => {
		expect(resolvePathInput("file:///Users/jeffrey/My%20Files/", posix)).toBe("/Users/jeffrey/My Files");
		expect(resolvePathInput("file:///C:/Users/me/Docs", posix)).toBe("C:\\Users\\me\\Docs");
	});

	it("rejects blank input", () => {
		expect(resolvePathInput("   ", posix)).toBeNull();
		expect(resolvePathInput('""', posix)).toBeNull();
	});

	it("normalizes Windows drive and UNC paths with backslashes", () => {
		const windows = { current: "C:\\Users\\me", home: "C:\\Users\\me" };
		expect(resolvePathInput("C:/Users/me/Documents/", windows)).toBe("C:\\Users\\me\\Documents");
		expect(resolvePathInput("d:\\", windows)).toBe("d:\\");
		expect(resolvePathInput("\\\\server\\share\\team\\..\\docs", windows)).toBe("\\\\server\\share\\docs");
		expect(resolvePathInput("~\\Desktop", windows)).toBe("C:\\Users\\me\\Desktop");
		expect(resolvePathInput("Downloads", windows)).toBe("C:\\Users\\me\\Downloads");
	});

	it("treats input as root-relative when the folder in view is not absolute", () => {
		expect(resolvePathInput("Documents/Finance/", { current: "Documents/Finance/2026 Q3", home: null })).toBe("Documents/Finance");
		expect(resolvePathInput("Desktop", { current: "Recents", home: null })).toBe("Desktop");
	});
});
