import type { IpcRenderer } from "electron";
import { APPEARANCE_CHANNELS } from "../shared/appearance-contract";
import type { AppAppearance } from "../shared/settings-contract";

const APPEARANCE_FLAG = "--autorag-appearance=";

function validAppearance(value: unknown): value is AppAppearance {
	return value === "light" || value === "dark";
}

function readAppearanceArg(): AppAppearance {
	const arg = process.argv.find((value) => value.startsWith(APPEARANCE_FLAG));
	const value = arg?.slice(APPEARANCE_FLAG.length);
	return validAppearance(value) ? value : "light";
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
	return typeof value === "object" && value !== null;
}

function documentRoot(): Record<PropertyKey, unknown> | null {
	const documentValue: unknown = Reflect.get(globalThis, "document");
	if (!isObject(documentValue)) return null;
	const documentElement: unknown = documentValue["documentElement"];
	return isObject(documentElement) ? documentElement : null;
}

function applyAppearance(value: AppAppearance): boolean {
	const documentElement = documentRoot();
	if (documentElement === null) return false;
	const dataset: unknown = documentElement["dataset"];
	if (!isObject(dataset)) return false;
	dataset["appearance"] = value;
	return true;
}

function installInitialAppearance(value: AppAppearance): void {
	if (applyAppearance(value)) return;
	const documentValue: unknown = Reflect.get(globalThis, "document");
	if (typeof documentValue !== "object" || documentValue === null) return;
	const addEventListener: unknown = Reflect.get(documentValue, "addEventListener");
	if (typeof addEventListener !== "function") return;
	Reflect.apply(addEventListener, documentValue, ["DOMContentLoaded", () => applyAppearance(value)]);
}

export function installAppearancePreload(ipcRenderer: IpcRenderer): void {
	installInitialAppearance(readAppearanceArg());
	ipcRenderer.on(APPEARANCE_CHANNELS.changed, (_event, appearance: unknown) => {
		if (validAppearance(appearance)) applyAppearance(appearance);
	});
}
