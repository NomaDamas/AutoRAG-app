import { useEffect, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { PreviewDocument } from "../shared/contract";
import { parseIcs, type IcsEvent, type IcsMoment, type IcsRecurrence } from "../shared/ics";
import { useChrome } from "./chrome";
import { FallbackView } from "./fallback";

const CALENDAR_SIZE = { width: 680, height: 600 } as const;

const REPEAT_KEYS = {
	DAILY: ["quickLook.calendar.repeatDaily", "quickLook.calendar.repeatDailyEvery"],
	WEEKLY: ["quickLook.calendar.repeatWeekly", "quickLook.calendar.repeatWeeklyEvery"],
	MONTHLY: ["quickLook.calendar.repeatMonthly", "quickLook.calendar.repeatMonthlyEvery"],
	YEARLY: ["quickLook.calendar.repeatYearly", "quickLook.calendar.repeatYearlyEvery"],
} as const;

function momentText(moment: IcsMoment | null): string {
	if (moment === null) return "";
	return moment.time === null ? moment.date : `${moment.date} ${moment.time}${moment.zone === null ? "" : ` (${moment.zone})`}`;
}

/** `DATE TIME (ZONE) – TIME`, collapsing the end's date when it is the same day. */
function rangeText(event: IcsEvent): string {
	const { start, end } = event;
	if (start === null) return "";
	if (end === null) return momentText(start);
	if (event.allDay) {
		// An all-day DTEND is exclusive: the last shown day is the one before it.
		const last = new Date(`${end.date}T00:00:00Z`);
		last.setUTCDate(last.getUTCDate() - 1);
		const lastDate = last.toISOString().slice(0, 10);
		return lastDate <= start.date ? start.date : `${start.date} – ${lastDate}`;
	}
	const sameDay = end.date === start.date;
	const tail = sameDay ? `${end.time ?? ""}${end.zone !== null && end.zone !== start.zone ? ` (${end.zone})` : ""}` : momentText(end);
	return `${momentText(start)} – ${tail}`;
}

function Repeat({ rule }: { readonly rule: IcsRecurrence }): ReactElement {
	const { t } = useTranslation();
	const keys = REPEAT_KEYS[rule.freq as keyof typeof REPEAT_KEYS];
	const base = keys === undefined ? t("quickLook.calendar.repeatOther") : rule.interval > 1 ? t(keys[1], { count: rule.interval }) : t(keys[0]);
	const parts = [base];
	if (rule.byDay.length > 0) parts.push(t("quickLook.calendar.repeatOn", { days: rule.byDay.join(", ") }));
	if (rule.count !== null) parts.push(t("quickLook.calendar.repeatTimes", { count: rule.count }));
	if (rule.until !== null) parts.push(t("quickLook.calendar.repeatUntil", { date: rule.until }));
	return <>{parts.join(" · ")}</>;
}

/** iCalendar files: each event with its time zone, place, notes, and a recurrence summary. */
export function CalendarView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t, i18n } = useTranslation();
	const { report } = useChrome();
	const events = useMemo(() => (file.bytes === null ? null : parseIcs(file.bytes)), [file.bytes]);
	useEffect(() => report(CALENDAR_SIZE, "clamp"), [report]);
	if (events === null) return <FallbackView file={file} note={t("quickLook.calendar.readFailed")} />;
	if (events.length === 0) return <FallbackView file={file} note={t("quickLook.calendar.empty")} />;
	return (
		<div className="flex flex-col flex-1 min-h-0 border-t-[0.5px] border-ql-hairline bg-ql-paper">
			<div className="flex-none px-24 py-8 text-[11.5px] text-ql-ink-secondary border-b-[0.5px] border-ql-hairline">
				{t("quickLook.calendar.events", { count: events.length.toLocaleString(i18n.language) })}
			</div>
			<ul className="flex-1 min-h-0 m-0 p-0 overflow-auto list-none">
				{events.map((event, index) => (
					<li key={index} className="px-24 py-14 border-b-[0.5px] border-ql-hairline">
						<div className="text-[15px] font-semibold break-words select-text">{event.summary === "" ? t("quickLook.calendar.noTitle") : event.summary}</div>
						<div className="mt-2 text-[12.5px] text-ql-ink-secondary select-text">
							{event.allDay ? `${t("quickLook.calendar.allDay")} · ` : ""}
							{rangeText(event)}
						</div>
						{event.recurrence === null ? null : (
							<div className="text-[12.5px] text-ql-ink-secondary">
								<Repeat rule={event.recurrence} />
							</div>
						)}
						{event.location === "" ? null : (
							<div className="mt-4 text-[12.5px] select-text">
								<span className="mr-8 text-ql-ink-secondary">{t("quickLook.calendar.location")}</span>
								{event.location}
							</div>
						)}
						{event.description === "" ? null : <div className="mt-4 text-[12.5px] leading-[1.5] whitespace-pre-wrap break-words select-text">{event.description}</div>}
					</li>
				))}
			</ul>
		</div>
	);
}
