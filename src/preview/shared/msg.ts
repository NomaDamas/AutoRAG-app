import * as CFB from "cfb";
import type { MailAttachment, MailMessage } from "./mail";

/**
 * Outlook `.msg`: an OLE2 compound file whose MAPI properties are streams
 * named `__substg1.0_<tag:4 hex><type:4 hex>` (`001F` UTF-16, `001E` ANSI,
 * `0102` binary). Attachments live in `__attach_version1.0_#N` storages.
 */

const TAGS = {
	subject: "0037",
	senderName: "0C1A",
	senderEmail: "0C1F",
	senderSmtp: "5D01",
	to: "0E04",
	cc: "0E03",
	body: "1000",
	html: "1013",
	attachLong: "3707",
	attachShort: "3704",
	attachMime: "370E",
	attachData: "3701",
} as const;

type Streams = Readonly<Record<string, Uint8Array>>;

function decodeAnsi(bytes: Uint8Array): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return new TextDecoder("euc-kr").decode(bytes);
	}
}

function trimNul(text: string): string {
	const end = text.indexOf("\0");
	return end < 0 ? text : text.slice(0, end);
}

/** A string property in whichever of UTF-16, ANSI, or binary form the file stored it. */
function stringProperty(streams: Streams, tag: string): string | null {
	const wide = streams[`${tag}001F`];
	if (wide !== undefined) return trimNul(new TextDecoder("utf-16le").decode(wide));
	const narrow = streams[`${tag}001E`] ?? streams[`${tag}0102`];
	return narrow === undefined ? null : trimNul(decodeAnsi(narrow));
}

function collect(entries: readonly { readonly path: string; readonly data: Uint8Array }[], prefix: string): Streams {
	const streams: Record<string, Uint8Array> = {};
	for (const { path, data } of entries) {
		if (!path.startsWith(prefix)) continue;
		const rest = path.slice(prefix.length);
		const match = /^__substg1\.0_([0-9A-Fa-f]{8})$/.exec(rest);
		if (match !== null) streams[(match[1] ?? "").toUpperCase()] = data;
	}
	return streams;
}

function recipients(value: string | null): readonly string[] {
	return value === null ? [] : value.split(";").map((part) => part.trim()).filter((part) => part !== "");
}

/** Reads a `.msg`; throws when the bytes are not a compound file. */
export function parseMsg(bytes: Uint8Array): MailMessage {
	const file = CFB.parse(bytes as unknown as number[]);
	const entries = file.FileIndex.flatMap((entry, index) => {
		const full = file.FullPaths[index];
		if (entry.type !== 2 || full === undefined || entry.content === undefined) return [];
		// "Root Entry/__substg1.0_..." -> "__substg1.0_..."
		return [{ path: full.slice(full.indexOf("/") + 1), data: Uint8Array.from(entry.content as ArrayLike<number>) }];
	});
	const top = collect(entries, "");
	const senderName = stringProperty(top, TAGS.senderName);
	const senderAddress = stringProperty(top, TAGS.senderSmtp) ?? stringProperty(top, TAGS.senderEmail);
	const sender = senderName !== null && senderAddress !== null && senderName !== senderAddress ? `${senderName} <${senderAddress}>` : (senderName ?? senderAddress);
	const htmlBytes = top[`${TAGS.html}0102`];
	const html = htmlBytes === undefined ? stringProperty(top, TAGS.html) : decodeAnsi(htmlBytes);
	const attachments: MailAttachment[] = [];
	const folders = [...new Set(entries.map((entry) => /^(__attach_version1\.0_#[0-9A-Fa-f]{8})\//.exec(entry.path)?.[1]).filter((name): name is string => name !== undefined))].sort();
	for (const folder of folders) {
		const streams = collect(entries, `${folder}/`);
		attachments.push({
			name: stringProperty(streams, TAGS.attachLong) ?? stringProperty(streams, TAGS.attachShort) ?? "attachment",
			size: (streams[`${TAGS.attachData}0102`] ?? new Uint8Array()).length,
			type: stringProperty(streams, TAGS.attachMime) ?? "application/octet-stream",
		});
	}
	return {
		subject: stringProperty(top, TAGS.subject) ?? "",
		from: sender === null || sender === "" ? [] : [sender],
		to: recipients(stringProperty(top, TAGS.to)),
		cc: recipients(stringProperty(top, TAGS.cc)),
		date: null,
		text: stringProperty(top, TAGS.body),
		html,
		attachments,
		inlineImages: {},
	};
}
