/** iCalendar (RFC 5545) event lists for the Quick Look preview. */

export interface IcsMoment {
	/** `YYYY-MM-DD`. */
	readonly date: string;
	/** `HH:MM`; null for an all-day date. */
	readonly time: string | null;
	/** IANA zone from TZID, `UTC` for a `Z` time, null for floating or all-day. */
	readonly zone: string | null;
}

export interface IcsRecurrence {
	readonly freq: string;
	readonly interval: number;
	readonly count: number | null;
	/** `YYYY-MM-DD` of UNTIL, or null. */
	readonly until: string | null;
	readonly byDay: readonly string[];
}

export interface IcsEvent {
	readonly summary: string;
	readonly start: IcsMoment | null;
	readonly end: IcsMoment | null;
	readonly allDay: boolean;
	readonly location: string;
	readonly description: string;
	readonly recurrence: IcsRecurrence | null;
}

const MAX_EVENTS = 1000;

function decodeBytes(bytes: Uint8Array): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return new TextDecoder("euc-kr").decode(bytes);
	}
}

function unfold(text: string): string[] {
	const lines: string[] = [];
	for (const raw of text.split(/\r\n|\r|\n/)) {
		const last = lines.length - 1;
		if ((raw.startsWith(" ") || raw.startsWith("\t")) && last >= 0) lines[last] += raw.slice(1);
		else lines.push(raw);
	}
	return lines;
}

function unescapeText(value: string): string {
	return value.replace(/\\([nN,;\\])/g, (_, char: string) => (char === "n" || char === "N" ? "\n" : char));
}

function moment(value: string, params: Readonly<Record<string, string>>): IcsMoment | null {
	const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(?:\d{2})?(Z)?)?$/.exec(value.trim());
	if (match === null) return null;
	const date = `${match[1]}-${match[2]}-${match[3]}`;
	if (match[4] === undefined) return { date, time: null, zone: null };
	return { date, time: `${match[4]}:${match[5]}`, zone: match[6] === "Z" ? "UTC" : (params["TZID"] ?? null) };
}

function recurrence(value: string): IcsRecurrence | null {
	const rule: Record<string, string> = {};
	for (const part of value.split(";")) {
		const equals = part.indexOf("=");
		if (equals > 0) rule[part.slice(0, equals).toUpperCase()] = part.slice(equals + 1);
	}
	const freq = rule["FREQ"];
	if (freq === undefined) return null;
	const until = moment(rule["UNTIL"] ?? "", {});
	const interval = Number.parseInt(rule["INTERVAL"] ?? "1", 10);
	const count = rule["COUNT"] === undefined ? Number.NaN : Number.parseInt(rule["COUNT"], 10);
	return {
		freq: freq.toUpperCase(),
		interval: Number.isFinite(interval) && interval > 0 ? interval : 1,
		count: Number.isFinite(count) ? count : null,
		until: until?.date ?? null,
		byDay: rule["BYDAY"] === undefined ? [] : rule["BYDAY"].split(","),
	};
}

/** Reads every VEVENT (up to a cap) in file order. Junk yields an empty list. */
export function parseIcs(bytes: Uint8Array): IcsEvent[] {
	const events: IcsEvent[] = [];
	let fields: Record<string, { readonly params: Record<string, string>; readonly value: string }> | null = null;
	for (const line of unfold(decodeBytes(bytes))) {
		const upper = line.trim().toUpperCase();
		if (upper === "BEGIN:VEVENT") {
			fields = {};
			continue;
		}
		if (upper === "END:VEVENT") {
			if (fields !== null) {
				const start = fields["DTSTART"] === undefined ? null : moment(fields["DTSTART"].value, fields["DTSTART"].params);
				const end = fields["DTEND"] === undefined ? null : moment(fields["DTEND"].value, fields["DTEND"].params);
				events.push({
					summary: unescapeText(fields["SUMMARY"]?.value ?? ""),
					start,
					end,
					allDay: start !== null && start.time === null,
					location: unescapeText(fields["LOCATION"]?.value ?? ""),
					description: unescapeText(fields["DESCRIPTION"]?.value ?? ""),
					recurrence: fields["RRULE"] === undefined ? null : recurrence(fields["RRULE"].value),
				});
			}
			fields = null;
			if (events.length >= MAX_EVENTS) break;
			continue;
		}
		if (fields === null) continue;
		let quoted = false;
		let colon = -1;
		for (let i = 0; i < line.length; i++) {
			if (line[i] === '"') quoted = !quoted;
			else if (line[i] === ":" && !quoted) {
				colon = i;
				break;
			}
		}
		if (colon <= 0) continue;
		const [name = "", ...rawParams] = line.slice(0, colon).split(";");
		const params: Record<string, string> = {};
		for (const item of rawParams) {
			const equals = item.indexOf("=");
			if (equals > 0) params[item.slice(0, equals).toUpperCase()] = item.slice(equals + 1).replace(/^"|"$/g, "");
		}
		const key = name.toUpperCase();
		if (fields[key] === undefined) fields[key] = { params, value: line.slice(colon + 1) };
	}
	return events;
}
