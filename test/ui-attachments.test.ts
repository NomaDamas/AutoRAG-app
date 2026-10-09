import { describe, expect, it } from "vitest";
import {
	FINDER_DRAG_TYPE,
	attachmentsFromDrop,
	finderDragEntries,
	isAttachmentDrag,
	isFileTransferDrag,
	isFinderDrag,
	mergeAttachments,
	readDropPaths,
	readFinderDragPaths,
	writeFinderDrag,
	type DropData,
} from "../src/renderer/src/state/attachments";

interface FakeFile {
	readonly name: string;
	/** "" models a dragged blob with no file on disk (e.g. an image from a web page). */
	readonly path: string;
	readonly directory?: boolean;
}

function drop(data: Readonly<Record<string, string>>, files: readonly FakeFile[] = []): DropData<FakeFile> {
	const types = [...(files.length > 0 ? ["Files"] : []), ...Object.keys(data)];
	return {
		types,
		getData: (format) => data[format] ?? "",
		items: files.map((file) => ({
			kind: "file",
			getAsFile: () => file,
			webkitGetAsEntry: () => ({ isDirectory: file.directory === true }),
		})),
	};
}

const pathForFile = (file: FakeFile): string => file.path;

describe("isAttachmentDrag", () => {
	it("accepts files, links, and Finder rows but not bare text", () => {
		expect(isAttachmentDrag(["Files"])).toBe(true);
		expect(isAttachmentDrag(["text/uri-list", "text/plain"])).toBe(true);
		expect(isAttachmentDrag([FINDER_DRAG_TYPE, "text/plain"])).toBe(true);
		expect(isAttachmentDrag(["text/plain", "text/html"])).toBe(false);
		expect(isAttachmentDrag([])).toBe(false);
	});
});

describe("isFileTransferDrag", () => {
	it("accepts OS files, file links, and Finder rows but not bare text", () => {
		expect(isFileTransferDrag(["Files"])).toBe(true);
		expect(isFileTransferDrag(["text/uri-list", "text/plain"])).toBe(true);
		expect(isFileTransferDrag([FINDER_DRAG_TYPE, "text/plain"])).toBe(true);
		expect(isFileTransferDrag(["text/plain", "text/html"])).toBe(false);
		expect(isFileTransferDrag([])).toBe(false);
	});
});

describe("readDropPaths", () => {
	it("reads the absolute paths of OS files and folders dropped from another app", () => {
		expect(
			readDropPaths(
				drop({}, [
					{ name: "report.pdf", path: "/Users/me/Downloads/report.pdf" },
					{ name: "Q3", path: "/Users/me/Documents/Q3", directory: true },
				]),
				pathForFile,
			),
		).toEqual(["/Users/me/Downloads/report.pdf", "/Users/me/Documents/Q3"]);
	});

	it("reads Finder rows and file URLs, ignoring web links", () => {
		const data: Record<string, string> = {
			[FINDER_DRAG_TYPE]: JSON.stringify([{ path: "/d/a.txt", name: "a.txt", kind: "file" }]),
			"text/uri-list": ["file:///Users/me/My%20Notes/plan%20v2.md", "https://example.com/page"].join("\r\n"),
		};
		expect(readDropPaths(drop(data), pathForFile)).toEqual(["/d/a.txt", "/Users/me/My Notes/plan v2.md"]);
	});

	it("reads Windows drive and UNC file URLs back to native paths", () => {
		const data = { "text/uri-list": ["file:///C:/Users/me/My%20Notes/plan.md", "file://srv/share/dir/a.txt"].join("\r\n") };
		expect(readDropPaths(drop(data), pathForFile)).toEqual(["C:\\Users\\me\\My Notes\\plan.md", "\\\\srv\\share\\dir\\a.txt"]);
	});

	it("round-trips a Windows path through the URI list an in-app drag writes", () => {
		const data: Record<string, string> = {};
		writeFinderDrag(
			{ effectAllowed: "none", setData: (format: string, value: string) => void (data[format] = value) },
			[
				{ path: "C:\\Users\\me\\한글 문서.md", name: "한글 문서.md", kind: "file" },
				{ path: "\\\\srv\\share\\a b.txt", name: "a b.txt", kind: "file" },
			],
		);
		expect(data["text/uri-list"]).toBe("file:///C:/Users/me/%ED%95%9C%EA%B8%80%20%EB%AC%B8%EC%84%9C.md\r\nfile://srv/share/a%20b.txt");
		expect(readDropPaths(drop({ "text/uri-list": data["text/uri-list"]! }), pathForFile)).toEqual([
			"C:\\Users\\me\\한글 문서.md",
			"\\\\srv\\share\\a b.txt",
		]);
	});

	it("lists a path once when the drop carries it as both a file and a file URL", () => {
		expect(
			readDropPaths(
				drop({ "text/uri-list": "file:///Users/me/a.txt" }, [{ name: "a.txt", path: "/Users/me/a.txt" }]),
				pathForFile,
			),
		).toEqual(["/Users/me/a.txt"]);
	});

	it("ignores a dropped file with no disk path or a non-absolute one", () => {
		expect(readDropPaths(drop({}, [{ name: "image.png", path: "" }]), pathForFile)).toEqual([]);
		expect(readDropPaths(drop({}, [{ name: "relative.txt", path: "relative.txt" }]), pathForFile)).toEqual([]);
	});

	it("returns nothing for a bare text drag", () => {
		expect(readDropPaths(drop({ "text/plain": "/d/a.txt" }), pathForFile)).toEqual([]);
	});
});

describe("attachmentsFromDrop", () => {
	it("turns files dropped from another app into absolute-path attachments", () => {
		const attachments = attachmentsFromDrop(
			drop({}, [
				{ name: "report.pdf", path: "/Users/me/Downloads/report.pdf" },
				{ name: "Q3", path: "/Users/me/Documents/Q3", directory: true },
			]),
			pathForFile,
		);

		expect(attachments).toEqual([
			{ kind: "file", id: "/Users/me/Downloads/report.pdf", name: "report.pdf" },
			{ kind: "folder", id: "/Users/me/Documents/Q3", name: "Q3" },
		]);
	});

	it("skips files that have no path on disk", () => {
		expect(attachmentsFromDrop(drop({}, [{ name: "image.png", path: "" }]), pathForFile)).toEqual([]);
	});

	it("turns dropped links into URL attachments and file URLs into files", () => {
		const attachments = attachmentsFromDrop(
			drop({
				"text/uri-list": [
					"# dragged from a browser",
					"https://ko.wikipedia.org/wiki/%EC%84%9C%EC%9A%B8",
					"file:///Users/me/My%20Notes/plan%20v2.md",
					"javascript:alert(1)",
					"",
				].join("\r\n"),
			}),
			pathForFile,
		);

		expect(attachments).toEqual([
			{ kind: "url", id: "https://ko.wikipedia.org/wiki/%EC%84%9C%EC%9A%B8", name: "ko.wikipedia.org/wiki/서울" },
			{ kind: "file", id: "/Users/me/My Notes/plan v2.md", name: "plan v2.md" },
		]);
	});

	it("reads the Finder's own row drag with its folder kinds", () => {
		const data: Record<string, string> = {};
		writeFinderDrag(
			{
				effectAllowed: "uninitialized",
				setData: (format, value) => {
					data[format] = value;
				},
			},
			[
				{ path: "/Users/me/Documents/budget.xlsx", name: "budget.xlsx", kind: "file" },
				{ path: "/Users/me/Documents/Archive", name: "Archive", kind: "folder" },
			],
		);

		const attachments = attachmentsFromDrop(drop(data), pathForFile);

		expect(attachments).toEqual([
			{ kind: "file", id: "/Users/me/Documents/budget.xlsx", name: "budget.xlsx" },
			{ kind: "folder", id: "/Users/me/Documents/Archive", name: "Archive" },
		]);
	});

	it("lists a file once when the drop carries it as both a file and a file URL", () => {
		const attachments = attachmentsFromDrop(
			drop({ "text/uri-list": "file:///Users/me/a.txt" }, [{ name: "a.txt", path: "/Users/me/a.txt" }]),
			pathForFile,
		);

		expect(attachments).toEqual([{ kind: "file", id: "/Users/me/a.txt", name: "a.txt" }]);
	});
});

describe("writeFinderDrag", () => {
	it("offers the rows as a copy-or-move with file URLs and plain paths for other drop targets", () => {
		const data: Record<string, string> = {};
		const target = {
			effectAllowed: "uninitialized",
			setData: (format: string, value: string) => {
				data[format] = value;
			},
		};

		writeFinderDrag(target, [{ path: "/Users/me/한글 문서.md", name: "한글 문서.md", kind: "file" }]);

		expect(target.effectAllowed).toBe("copyMove");
		expect(data["text/uri-list"]).toBe("file:///Users/me/%ED%95%9C%EA%B8%80%20%EB%AC%B8%EC%84%9C.md");
		expect(data["text/plain"]).toBe("/Users/me/한글 문서.md");
	});
});

describe("readFinderDragPaths", () => {
	it("reads the absolute paths an in-app row drag carries", () => {
		const data: Record<string, string> = {};
		writeFinderDrag(
			{
				effectAllowed: "uninitialized",
				setData: (format, value) => {
					data[format] = value;
				},
			},
			[
				{ path: "/d/a.txt", name: "a.txt", kind: "file" },
				{ path: "/d/Sub", name: "Sub", kind: "folder" },
			],
		);
		expect(readFinderDragPaths(drop(data))).toEqual(["/d/a.txt", "/d/Sub"]);
	});

	it("returns nothing for a foreign drag or a malformed payload", () => {
		expect(readFinderDragPaths(drop({ "text/plain": "/d/a.txt" }))).toEqual([]);
		expect(readFinderDragPaths(drop({ [FINDER_DRAG_TYPE]: "not json" }))).toEqual([]);
		expect(isFinderDrag([FINDER_DRAG_TYPE, "text/plain"])).toBe(true);
		expect(isFinderDrag(["Files", "text/plain"])).toBe(false);
	});
});

describe("mergeAttachments", () => {
	it("dedupes by path or URL, so same-named files from different folders both stay", () => {
		const merged = mergeAttachments(
			[{ kind: "file", id: "/a/notes.md", name: "notes.md" }],
			[
				{ kind: "file", id: "/b/notes.md", name: "notes.md" },
				{ kind: "file", id: "/a/notes.md", name: "notes.md" },
				{ kind: "url", id: "https://example.com", name: "example.com" },
			],
		);

		expect(merged.map((att) => att.id)).toEqual(["/a/notes.md", "/b/notes.md", "https://example.com"]);
	});
});

describe("finderDragEntries", () => {
	const entries = [
		{ path: "/d/a.txt", name: "a.txt", kind: "file" as const },
		{ path: "/d/b.txt", name: "b.txt", kind: "file" as const },
		{ path: "/d/c", name: "c", kind: "folder" as const },
	];

	it("drags the whole selection when the grabbed row is selected", () => {
		expect(finderDragEntries(entries[2]!, ["/d/c", "/d/a.txt"], entries).map((entry) => entry.path)).toEqual(["/d/a.txt", "/d/c"]);
	});

	it("drags only the grabbed row when it is not selected", () => {
		expect(finderDragEntries(entries[1]!, ["/d/a.txt"], entries).map((entry) => entry.path)).toEqual(["/d/b.txt"]);
	});
});
