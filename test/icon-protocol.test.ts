import { describe, expect, it } from "vitest";
import type { IconStore } from "../src/main/file-icon";
import { THUMB_SCHEME, handleIconRequest, iconIdentityFromUrl, iconUrl } from "../src/main/icon-protocol";

const MTIME = "2026-09-29T00:00:00.000Z";
const BYTES = new Uint8Array([137, 80, 78, 71]);
const store = (bytes: ReadonlyMap<string, Uint8Array>): IconStore => ({
	read: (path, modifiedAt) => bytes.get(`${path}\u0000${modifiedAt}`) ?? null,
});
const raw = (query: string, host = "local", path = "/") =>
	`${THUMB_SCHEME}://${host}${path}?${query}`;
const encodedPath = encodeURIComponent("/docs/a.png");

describe("iconUrl / iconIdentityFromUrl", () => {
	it("round-trips an absolute path with spaces, unicode, and URL metacharacters", () => {
		const path = "/Users/me/Ärger docs/a #1 & b?.png";
		const decoded = iconIdentityFromUrl(iconUrl(path, MTIME));
		expect(decoded).toEqual({ path, modifiedAt: MTIME });
	});

	it("uses the modifiedAt as the cache identity, so a changed file gets a new URL", () => {
		expect(iconUrl("/docs/a.png", "t1")).not.toBe(iconUrl("/docs/a.png", "t2"));
	});

	it("rejects a foreign scheme and an unparsable URL", () => {
		expect(iconIdentityFromUrl("autorag-preview://local/?path=%2Fdocs%2Fa.png&mtime=2026-09-29T00%3A00%3A00.000Z")).toBeNull();
		expect(iconIdentityFromUrl("not a url")).toBeNull();
	});

	it("rejects relative, NUL-bearing, and timestamp-less identities", () => {
		expect(iconIdentityFromUrl(iconUrl("docs/a.png", MTIME))).toBeNull();
		expect(iconIdentityFromUrl(iconUrl("/docs/a\u0000.png", MTIME))).toBeNull();
		expect(iconIdentityFromUrl(`${THUMB_SCHEME}://local/?path=%2Fdocs%2Fa.png`)).toBeNull();
		expect(iconIdentityFromUrl(`${THUMB_SCHEME}://local/?path=%2Fdocs%2Fa.png&mtime=not-a-date`)).toBeNull();
	});

	it("rejects a foreign host or a non-root path", () => {
		expect(iconIdentityFromUrl(raw(`path=${encodedPath}&mtime=${MTIME}`, "evil"))).toBeNull();
		expect(iconIdentityFromUrl(raw(`path=${encodedPath}&mtime=${MTIME}`, "local", "/foo"))).toBeNull();
	});

	it("rejects credentials and ports", () => {
		expect(iconIdentityFromUrl(`${THUMB_SCHEME}://user:pass@local/?path=${encodedPath}&mtime=${MTIME}`)).toBeNull();
		expect(iconIdentityFromUrl(`${THUMB_SCHEME}://local:8080/?path=${encodedPath}&mtime=${MTIME}`)).toBeNull();
	});

	it("rejects unexpected or duplicated query parameters", () => {
		expect(iconIdentityFromUrl(raw(`path=${encodedPath}&mtime=${MTIME}&x=1`))).toBeNull();
		expect(iconIdentityFromUrl(raw(`path=${encodedPath}&path=%2Fdocs%2Fb.png&mtime=${MTIME}`))).toBeNull();
		expect(iconIdentityFromUrl(raw(`path=${encodedPath}&mtime=${MTIME}&mtime=${MTIME}`))).toBeNull();
	});
});

describe("handleIconRequest", () => {
	it("serves cached PNG bytes as an immutable, CORS-readable image response", async () => {
		const icons = store(new Map([["/docs/a.png\u0000" + MTIME, BYTES]]));

		const response = await handleIconRequest(new Request(iconUrl("/docs/a.png", MTIME)), icons);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
		expect(response.headers.get("content-length")).toBe(String(BYTES.byteLength));
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
	});

	it("answers 404 with no-store for an identity the OS produced no icon for", async () => {
		const response = await handleIconRequest(new Request(iconUrl("/docs/a.png", MTIME)), store(new Map()));
		expect(response.status).toBe(404);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
	});

	it("answers 400 with no-store for a malformed thumbnail URL", async () => {
		const response = await handleIconRequest(new Request(iconUrl("docs/relative.png", MTIME)), store(new Map()));
		expect(response.status).toBe(400);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
	});
});
