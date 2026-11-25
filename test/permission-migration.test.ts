import { describe, expect, it } from "vitest";
import { migrateLegacyPermissionMode } from "../src/main/permission-migration";

describe("migrateLegacyPermissionMode", () => {
	it("rewrites retired ask and auto permissionMode values to readonly", () => {
		expect(migrateLegacyPermissionMode({ permissionMode: "ask", searchPaths: ["/docs"] })).toEqual({
			raw: { permissionMode: "readonly", searchPaths: ["/docs"] },
			changed: true,
		});
		expect(migrateLegacyPermissionMode({ permissionMode: "AUTO" })).toEqual({
			raw: { permissionMode: "readonly" },
			changed: true,
		});
	});

	it("leaves readonly, full, absent, and unknown values untouched", () => {
		const readonlyRaw = { permissionMode: "readonly" };
		expect(migrateLegacyPermissionMode(readonlyRaw)).toEqual({ raw: readonlyRaw, changed: false });

		const fullRaw = { permissionMode: "full" };
		expect(migrateLegacyPermissionMode(fullRaw)).toEqual({ raw: fullRaw, changed: false });

		const emptyRaw = { searchPaths: ["/docs"] };
		expect(migrateLegacyPermissionMode(emptyRaw)).toEqual({ raw: emptyRaw, changed: false });

		const unknownRaw = { permissionMode: "yolo" };
		expect(migrateLegacyPermissionMode(unknownRaw)).toEqual({ raw: unknownRaw, changed: false });
	});
});
