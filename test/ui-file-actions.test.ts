import { describe, expect, it } from "vitest";
import { NO_CAPABILITIES, type ActionCapabilities } from "../src/shared/actions-contract";
import {
	fileExtension,
	openWithItems,
	suggestedActions,
	type FileAction,
	type FileActionItem,
} from "../src/renderer/src/state/file-actions";

/** What `capabilities()` reports on macOS 26 without ffmpeg: every sips-writable format. */
const DARWIN: ActionCapabilities = {
	openWith: true,
	share: true,
	archive: true,
	imageFormats: ["jpeg", "png", "heic", "avif", "gif", "tiff", "bmp"],
	videoContainers: [],
	reducibleExtensions: ["jpg", "jpeg", "heic", "heif"],
};

const DARWIN_FFMPEG: ActionCapabilities = {
	...DARWIN,
	imageFormats: ["jpeg", "png", "webp", "heic", "avif", "gif", "tiff", "bmp"],
	videoContainers: ["mp4", "mov", "mkv"],
	reducibleExtensions: ["pdf", "jpg", "jpeg", "png", "webp", "heic", "heif", "mp4", "mov", "mp3"],
};

function ids(actions: readonly FileAction[]): readonly string[] {
	return actions.map((action) => action.id);
}

function menuItems(actions: readonly FileAction[], id: string): readonly FileActionItem[] {
	const action = actions.find((candidate) => candidate.id === id);
	return action !== undefined && action.kind === "menu" ? action.items : [];
}

describe("fileExtension", () => {
	it("reads the trailing extension, ignoring dotfiles and missing suffixes", () => {
		expect(fileExtension("photo.JPEG")).toBe("jpeg");
		expect(fileExtension("archive.tar.gz")).toBe("gz");
		expect(fileExtension(".gitignore")).toBe("");
		expect(fileExtension("README")).toBe("");
		expect(fileExtension("trailing.")).toBe("");
	});
});

describe("openWithItems", () => {
	it("lists the OS-registered applications first, marks the default, and ends with 기타…", () => {
		const items = openWithItems([
			{ path: "/Applications/IINA.app", name: "IINA", isDefault: true, icon: "data:image/png;base64,AA" },
			{ path: "/Applications/VLC.app", name: "VLC", isDefault: false, icon: null },
		]);
		expect(items.map((item) => item.label)).toEqual(["IINA (기본)", "VLC", "기타…"]);
		expect(items[0]?.target).toEqual({
			kind: "request",
			request: { kind: "openWith", application: "/Applications/IINA.app" },
		});
		expect(items[2]).toMatchObject({
			separated: true,
			target: { kind: "request", request: { kind: "openWith", application: null } },
		});
	});

	it("offers only 기타… when the OS suggests nothing", () => {
		const items = openWithItems([]);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ label: "기타…", separated: false });
	});
});

describe("reduce size", () => {
	it("is one flat action for every type the machine can shrink, whatever the type", () => {
		for (const name of ["scan.pdf", "photo.PNG", "clip.mov", "song.mp3", "IMG_1.heic"]) {
			const action = suggestedActions({ name, kind: "file" }, DARWIN_FFMPEG).find((candidate) => candidate.id === "reduceSize");
			expect(action, name).toMatchObject({
				kind: "action",
				label: "용량 줄이기",
				icon: "reduce",
				target: { kind: "request", request: { kind: "reduceSize" } },
			});
		}
	});

	it("is absent for types the machine cannot shrink, folders, and unknown files", () => {
		expect(ids(suggestedActions({ name: "scan.pdf", kind: "file" }, DARWIN))).not.toContain("reduceSize");
		expect(ids(suggestedActions({ name: "notes.txt", kind: "file" }, DARWIN_FFMPEG))).not.toContain("reduceSize");
		expect(ids(suggestedActions({ name: "pics.jpg", kind: "folder" }, DARWIN_FFMPEG))).not.toContain("reduceSize");
		expect(ids(suggestedActions({ name: "photo.jpg", kind: "file" }, NO_CAPABILITIES))).not.toContain("reduceSize");
	});

	it("sits before archiving, after the type's own edit menu", () => {
		expect(ids(suggestedActions({ name: "photo.jpg", kind: "file" }, DARWIN_FFMPEG))).toEqual([
			"open",
			"openWith",
			"imageEdit",
			"reduceSize",
			"compress",
			"compress7z",
			"share",
			"askAi",
		]);
	});

	it("no longer hides an optimize entry inside the image menu", () => {
		const items = menuItems(suggestedActions({ name: "photo.heic", kind: "file" }, DARWIN), "imageEdit");
		expect(items.map((item) => item.id)).not.toContain("image:optimize");
	});
});

describe("base action set", () => {
	it("offers open, open-with, archive, share and AI to a plain file", () => {
		const actions = suggestedActions({ name: "notes.txt", kind: "file" }, DARWIN);
		expect(ids(actions)).toEqual(["open", "openWith", "compress", "compress7z", "share", "askAi"]);
		expect(actions.every((action) => action.kind === "action")).toBe(true);
	});

	it("drops open-with, archive and share for a folder", () => {
		const actions = suggestedActions({ name: "docs", kind: "folder" }, DARWIN);
		expect(ids(actions)).toEqual(["compress", "compress7z", "share", "askAi"]);
	});

	it("never offers an action the machine cannot run", () => {
		expect(ids(suggestedActions({ name: "notes.txt", kind: "file" }, NO_CAPABILITIES))).toEqual(["open", "askAi"]);
		expect(ids(suggestedActions({ name: "docs", kind: "folder" }, NO_CAPABILITIES))).toEqual(["askAi"]);
	});

	it("keeps Quick Look, copy path and trash out of the bar", () => {
		const actions = suggestedActions({ name: "notes.txt", kind: "file" }, DARWIN);
		expect(ids(actions)).not.toContain("quickLook");
		expect(ids(actions)).not.toContain("copyPath");
		expect(ids(actions)).not.toContain("trash");
	});
});

describe("archives", () => {
	it("extracts in place, before compressing", () => {
		const actions = suggestedActions({ name: "docs.zip", kind: "file" }, DARWIN);
		expect(ids(actions)).toEqual(["open", "openWith", "extract", "compress", "compress7z", "share", "askAi"]);
	});

	it("offers extraction for every archive format, but never a plain file", () => {
		expect(ids(suggestedActions({ name: "docs.tar", kind: "file" }, DARWIN))).toContain("extract");
		expect(ids(suggestedActions({ name: "docs.tar.gz", kind: "file" }, DARWIN))).toContain("extract");
		expect(ids(suggestedActions({ name: "docs.7z", kind: "file" }, DARWIN))).toContain("extract");
		expect(ids(suggestedActions({ name: "docs.rar", kind: "file" }, DARWIN))).toContain("extract");
		expect(ids(suggestedActions({ name: "notes.txt", kind: "file" }, DARWIN))).not.toContain("extract");
		expect(ids(suggestedActions({ name: "docs.zip", kind: "file" }, NO_CAPABILITIES))).not.toContain("extract");
	});
});

describe("image menu", () => {
	it("offers every other native format plus resize presets, for a PNG", () => {
		const actions = suggestedActions({ name: "photo.png", kind: "file" }, DARWIN);
		const items = menuItems(actions, "imageEdit");
		expect(items.map((item) => item.label)).toEqual([
			"JPEG로 변환",
			"HEIC로 변환",
			"AVIF로 변환",
			"GIF로 변환",
			"TIFF로 변환",
			"BMP로 변환",
			"최대 1920px",
			"최대 1280px",
			"최대 640px",
		]);
		expect(items.map((item) => item.id)).not.toContain("image:convert:png");
	});

	it("excludes the source's own format from conversion", () => {
		const actions = suggestedActions({ name: "photo.heic", kind: "file" }, DARWIN);
		const items = menuItems(actions, "imageEdit");
		expect(items.map((item) => item.label)).not.toContain("HEIC로 변환");
	});

	it("leads an iPhone HEIC/HEIF photo's menu with JPEG and sends a JPEG conversion", () => {
		for (const name of ["IMG_0001.HEIC", "IMG_0002.heif"]) {
			const items = menuItems(suggestedActions({ name, kind: "file" }, DARWIN_FFMPEG), "imageEdit");
			expect(items[0]).toEqual({
				id: "image:convert:jpeg",
				label: "JPEG로 변환",
				target: { kind: "request", request: { kind: "convertImage", format: "jpeg" } },
			});
			expect(items.slice(0, 6).map((item) => item.label)).toEqual([
				"JPEG로 변환",
				"PNG로 변환",
				"WebP로 변환",
				"AVIF로 변환",
				"GIF로 변환",
				"TIFF로 변환",
			]);
		}
	});

	it("converts GIF, BMP and AVIF to every other format; resizes BMP/AVIF but never a (possibly animated) GIF", () => {
		for (const name of ["anim.gif", "scan.bmp", "photo.avif"]) {
			const labels = menuItems(suggestedActions({ name, kind: "file" }, DARWIN), "imageEdit").map((item) => item.label);
			expect(labels).toContain("JPEG로 변환");
			expect(labels.filter((label) => label.endsWith("로 변환"))).toHaveLength(DARWIN.imageFormats.length - 1);
			expect(labels.includes("최대 640px")).toBe(name !== "anim.gif");
		}
	});

	it("adds WebP conversion only when the machine can encode it", () => {
		const withoutWebp = suggestedActions({ name: "photo.jpg", kind: "file" }, DARWIN);
		expect(menuItems(withoutWebp, "imageEdit").map((item) => item.label)).not.toContain("WebP로 변환");

		const withWebp = suggestedActions({ name: "photo.png", kind: "file" }, DARWIN_FFMPEG);
		const labels = menuItems(withWebp, "imageEdit").map((item) => item.label);
		expect(labels).toContain("JPEG로 변환");
		expect(labels).toContain("WebP로 변환");
		expect(labels).not.toContain("PNG로 변환");
	});

	it("hides the image menu entirely without an image engine", () => {
		const actions = suggestedActions({ name: "photo.png", kind: "file" }, NO_CAPABILITIES);
		expect(ids(actions)).not.toContain("imageEdit");
	});

	it("offers no image menu for a document", () => {
		expect(ids(suggestedActions({ name: "notes.md", kind: "file" }, DARWIN_FFMPEG))).not.toContain("imageEdit");
	});
});

describe("video menu", () => {
	it("converts to every other container", () => {
		const actions = suggestedActions({ name: "clip.mov", kind: "file" }, DARWIN_FFMPEG);
		expect(menuItems(actions, "videoConvert").map((item) => item.label)).toEqual(["MP4로 변환", "MKV로 변환"]);
	});

	it("hides the menu without ffmpeg", () => {
		expect(ids(suggestedActions({ name: "clip.mov", kind: "file" }, DARWIN))).not.toContain("videoConvert");
	});
});
