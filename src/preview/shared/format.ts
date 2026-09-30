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
