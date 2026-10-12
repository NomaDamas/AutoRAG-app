import { i18n, t } from "../../shared/i18n/core";

const UNITS = ["bytes", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(size: number): string {
	let value = size;
	let unit = 0;
	while (value >= 1024 && unit < UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const label = UNITS[unit] ?? "bytes";
	if (unit === 0) return `${size} ${label}`;
	const shown = value >= 10 ? value.toFixed(0) : value.toFixed(1);
	return `${shown} ${label}`;
}

export function formatModified(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day} ${hours}:${minutes}`;
}

export function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	if (dot <= 0 || dot === name.length - 1) return "";
	return name.slice(dot + 1).toLowerCase();
}

const FINDER_UNITS = ["KB", "MB", "GB", "TB"] as const;
/** Decimal places Finder shows per unit: whole kilobytes, then 1, 2, 2. */
const FINDER_DECIMALS = [0, 1, 2, 2] as const;

/** Decimal (1000-based) sizes, rounded the way Finder's Get Info and Quick Look print them. */
export function formatFinderSize(size: number): string {
	if (size === 0) return "Zero bytes";
	if (size < 1000) return size === 1 ? "1 byte" : `${size} bytes`;
	let value = size / 1000;
	let unit = 0;
	while (value >= 1000 && unit < FINDER_UNITS.length - 1) {
		value /= 1000;
		unit += 1;
	}
	const shown = Number(value.toFixed(FINDER_DECIMALS[unit])).toString();
	return `${shown} ${FINDER_UNITS[unit]}`;
}

const FINDER_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const FINDER_TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const FINDER_TIME_SECONDS = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });

/** "Aug 28, 2026 at 10:58:21 PM", the Finder's long date. */
export function formatFinderDate(iso: string, seconds: boolean): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	// Newer ICU puts a narrow no-break space before AM/PM; Finder prints a plain space.
	const time = (seconds ? FINDER_TIME_SECONDS : FINDER_TIME).format(date).replace(/\u202f/g, " ");
	return `${FINDER_DAY.format(date)} at ${time}`;
}

/** Media position: m:ss, or h:mm:ss past an hour. */
export function formatClock(seconds: number): string {
	const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
	const hours = Math.floor(whole / 3600);
	const minutes = Math.floor((whole % 3600) / 60);
	const rest = String(whole % 60).padStart(2, "0");
	return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

export function formatItemCount(count: number): string {
	if (count === 0) return t("quickLook.itemCount.zero");
	if (count === 1) return t("quickLook.itemCount.one");
	return t("quickLook.itemCount.many", { count: count.toLocaleString(i18n.language) });
}
