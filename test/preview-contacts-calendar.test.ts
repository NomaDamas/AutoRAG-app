import { describe, expect, it } from "vitest";
import { parseIcs } from "../src/preview/shared/ics";
import { parseVcf } from "../src/preview/shared/vcf";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("parseVcf", () => {
	it("reads a v3 card with folded lines, typed phones, and a photo", () => {
		const card = [
			"BEGIN:VCARD",
			"VERSION:3.0",
			"FN:김철수",
			"N:김;철수;;;",
			"ORG:다찌;개발팀",
			"TITLE:엔지니어",
			"TEL;TYPE=CELL:010-1234-5678",
			"TEL;TYPE=WORK,VOICE:02-123-4567",
			"EMAIL;TYPE=INTERNET:kim@example.com",
			"ADR;TYPE=HOME:;;테헤란로 1;서울;;06000;대한민국",
			"NOTE:line one\\nline two\\, with comma",
			"PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQ",
			" SkZJRg==",
			"END:VCARD",
		].join("\r\n");
		const [contact] = parseVcf(enc(card));
		expect(contact?.name).toBe("김철수");
		expect(contact?.org).toBe("다찌, 개발팀");
		expect(contact?.title).toBe("엔지니어");
		expect(contact?.phones).toEqual([
			{ type: "CELL", value: "010-1234-5678" },
			{ type: "WORK, VOICE", value: "02-123-4567" },
		]);
		expect(contact?.emails).toEqual([{ type: "", value: "kim@example.com" }]);
		expect(contact?.addresses).toEqual([{ type: "HOME", value: "테헤란로 1, 서울, 06000, 대한민국" }]);
		expect(contact?.note).toBe("line one\nline two, with comma");
		expect(contact?.photo).toBe("data:image/jpeg;base64,/9j/4AAQSkZJRg==");
	});

	it("builds a name from N when FN is missing, decodes v2.1 quoted-printable UTF-8 and v4 data URIs", () => {
		const cards = [
			"BEGIN:VCARD",
			"VERSION:2.1",
			"N:Doe;Jane;;Dr.;",
			"NOTE;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=ED=95=9C=EA=B8=80",
			"END:VCARD",
			"BEGIN:VCARD",
			"VERSION:4.0",
			"FN:Second",
			"PHOTO:data:image/png;base64,iVBORw0KGgo=",
			"END:VCARD",
		].join("\n");
		const contacts = parseVcf(enc(cards));
		expect(contacts).toHaveLength(2);
		expect(contacts[0]?.name).toBe("Dr. Jane Doe");
		expect(contacts[0]?.note).toBe("한글");
		expect(contacts[1]?.photo).toBe("data:image/png;base64,iVBORw0KGgo=");
	});

	it("drops photos that are not safe image types and returns nothing for junk", () => {
		const card = "BEGIN:VCARD\nFN:X\nPHOTO;ENCODING=b;TYPE=SVG:PHN2Zy8+\nPHOTO:http://tracker.example/p.png\nEND:VCARD";
		expect(parseVcf(enc(card))[0]?.photo).toBeNull();
		expect(parseVcf(enc("not a card"))).toEqual([]);
	});
});

describe("parseIcs", () => {
	const calendar = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"BEGIN:VEVENT",
		"SUMMARY:팀 회의",
		"DTSTART;TZID=Asia/Seoul:20261020T140000",
		"DTEND;TZID=Asia/Seoul:20261020T150000",
		"LOCATION:회의실 A",
		"DESCRIPTION:안건\\n1. 일정",
		"RRULE:FREQ=WEEKLY;COUNT=4;BYDAY=TU",
		"END:VEVENT",
		"BEGIN:VEVENT",
		"SUMMARY:Holiday",
		"DTSTART;VALUE=DATE:20261225",
		"DTEND;VALUE=DATE:20261226",
		"END:VEVENT",
		"BEGIN:VEVENT",
		"SUMMARY:UTC call",
		"DTSTART:20261020T050000Z",
		"RRULE:FREQ=DAILY;UNTIL=20261101T000000Z",
		"END:VEVENT",
		"END:VCALENDAR",
	].join("\r\n");

	it("lists events with zones, all-day flags, and recurrence summaries", () => {
		const events = parseIcs(enc(calendar));
		expect(events.map((e) => e.summary)).toEqual(["팀 회의", "Holiday", "UTC call"]);
		expect(events[0]).toMatchObject({
			start: { date: "2026-10-20", time: "14:00", zone: "Asia/Seoul" },
			end: { date: "2026-10-20", time: "15:00", zone: "Asia/Seoul" },
			location: "회의실 A",
			description: "안건\n1. 일정",
			allDay: false,
		});
		expect(events[0]?.recurrence).toEqual({ freq: "WEEKLY", interval: 1, count: 4, until: null, byDay: ["TU"] });
		expect(events[1]).toMatchObject({ allDay: true, start: { date: "2026-12-25", time: null, zone: null } });
		expect(events[2]?.start).toEqual({ date: "2026-10-20", time: "05:00", zone: "UTC" });
		expect(events[2]?.recurrence).toMatchObject({ freq: "DAILY", until: "2026-11-01" });
	});

	it("unfolds long lines and survives junk", () => {
		const folded = "BEGIN:VEVENT\r\nSUMMARY:very long\r\n  summary text\r\nEND:VEVENT";
		expect(parseIcs(enc(folded))[0]?.summary).toBe("very long summary text");
		expect(parseIcs(enc("garbage"))).toEqual([]);
	});
});
