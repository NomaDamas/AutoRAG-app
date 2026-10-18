import { useEffect, useMemo, useState, type MouseEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { PreviewDocument } from "../shared/contract";
import { formatFinderDate, formatFinderSize } from "../shared/format";
import { listMbox, parseEmlx, parseMail, readMboxMessage, type MailMessage, type MboxEntry } from "../shared/mail";
import { parseMsg } from "../shared/msg";
import { Segmented, ToolbarSlot, useChrome } from "./chrome";
import { FallbackView } from "./fallback";
import { renderMailHtml } from "./mail-html";

const MAIL_SIZE = { width: 820, height: 640 } as const;
const MBOX_SIZE = { width: 1040, height: 640 } as const;

function holdLinks(event: MouseEvent<HTMLElement>): void {
	if (event.target instanceof Element && event.target.closest("a") !== null) event.preventDefault();
}

function HeaderRow({ label, values }: { readonly label: string; readonly values: readonly string[] }): ReactElement | null {
	if (values.length === 0) return null;
	return (
		<div className="flex gap-12 text-[12.5px] leading-[1.6]">
			<dt className="flex-none w-56 text-right text-ql-ink-secondary">{label}</dt>
			<dd className="flex-1 min-w-0 m-0 break-words select-text">{values.join(", ")}</dd>
		</div>
	);
}

function MessagePane({ mail }: { readonly mail: MailMessage }): ReactElement {
	const { t, i18n } = useTranslation();
	const hasHtml = mail.html !== null && mail.html.trim() !== "";
	const hasText = mail.text !== null && mail.text.trim() !== "";
	const [mode, setMode] = useState<"rendered" | "plain">(hasHtml ? "rendered" : "plain");
	useEffect(() => setMode(hasHtml ? "rendered" : "plain"), [mail, hasHtml]);
	const html = useMemo(() => (hasHtml ? renderMailHtml(mail) : ""), [mail, hasHtml]);
	const modes = useMemo(
		() => [
			{ value: "rendered" as const, label: t("quickLook.mail.rendered") },
			{ value: "plain" as const, label: t("quickLook.mail.plain") },
		],
		[t, i18n.language],
	);
	return (
		<div className="flex flex-col flex-1 min-w-0 min-h-0 bg-ql-paper">
			{hasHtml && hasText ? (
				<ToolbarSlot>
					<Segmented label={t("quickLook.mail.viewMode")} options={modes} value={mode} onChange={setMode} />
				</ToolbarSlot>
			) : null}
			<div className="flex-none px-24 pt-18 pb-12 border-b-[0.5px] border-ql-hairline">
				<h1 className="m-0 mb-10 text-[18px] font-bold leading-[1.3] break-words select-text">{mail.subject === "" ? t("quickLook.mail.noSubject") : mail.subject}</h1>
				<dl className="flex flex-col m-0">
					<HeaderRow label={t("quickLook.mail.from")} values={mail.from} />
					<HeaderRow label={t("quickLook.mail.to")} values={mail.to} />
					<HeaderRow label={t("quickLook.mail.cc")} values={mail.cc} />
					<HeaderRow label={t("quickLook.mail.date")} values={mail.date === null ? [] : [/^\d{4}-\d{2}-\d{2}T/.test(mail.date) ? formatFinderDate(mail.date, false) : mail.date]} />
				</dl>
			</div>
			<div className="flex-1 min-h-0 overflow-auto">
				{mode === "rendered" && hasHtml ? (
					<article className="ql-md max-w-720 mx-auto px-24 py-18 select-text" onClick={holdLinks} dangerouslySetInnerHTML={{ __html: html }} />
				) : hasText ? (
					<pre className="m-0 px-24 py-18 font-ql text-[13px] leading-[1.6] whitespace-pre-wrap [word-break:break-word] select-text">{mail.text}</pre>
				) : (
					<p className="m-0 px-24 py-18 text-ql-ink-secondary text-[13px]">{t("quickLook.mail.noBody")}</p>
				)}
			</div>
			{mail.attachments.length === 0 ? null : (
				<div className="flex-none px-24 py-10 border-t-[0.5px] border-ql-hairline bg-ql-sunk">
					<div className="mb-4 text-[11.5px] font-semibold text-ql-ink-secondary">{t("quickLook.mail.attachments", { count: mail.attachments.length })}</div>
					<ul className="flex flex-col gap-2 m-0 p-0 list-none max-h-100 overflow-auto">
						{mail.attachments.map((attachment, index) => (
							<li key={index} className="flex items-baseline gap-10 text-[12px] select-text">
								<span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{attachment.name}</span>
								<span className="flex-none text-ql-ink-secondary">{attachment.type}</span>
								<span className="flex-none w-72 text-right text-ql-ink-secondary">{formatFinderSize(attachment.size)}</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

function MboxPane({ file, bytes }: { readonly file: PreviewDocument; readonly bytes: Uint8Array }): ReactElement {
	const { t, i18n } = useTranslation();
	const listing = useMemo(() => listMbox(bytes, file.truncated), [bytes, file.truncated]);
	const [selected, setSelected] = useState(0);
	useEffect(() => setSelected(0), [bytes]);
	const entry: MboxEntry | undefined = listing.messages[selected];
	const mail = useMemo(() => (entry === undefined ? null : readMboxMessage(bytes, entry)), [bytes, entry]);
	const count = listing.count.toLocaleString(i18n.language);
	return (
		<div className="flex flex-1 min-h-0 border-t-[0.5px] border-ql-hairline">
			<nav aria-label={t("quickLook.mail.messageList")} className="flex flex-col flex-none w-260 min-h-0 border-r-[0.5px] border-ql-hairline bg-ql-sunk">
				<div className="flex-none px-12 py-8 text-[11.5px] text-ql-ink-secondary border-b-[0.5px] border-ql-hairline">
					{listing.complete ? t("quickLook.mail.messages", { count }) : t("quickLook.mail.messagesAtLeast", { count })}
					{listing.count > listing.messages.length ? ` · ${t("quickLook.mail.listCapped", { count: listing.messages.length })}` : ""}
				</div>
				<ul className="flex-1 min-h-0 m-0 p-0 overflow-auto list-none">
					{listing.messages.map((message, index) => (
						<li key={message.start}>
							<button
								type="button"
								aria-current={index === selected}
								onClick={() => setSelected(index)}
								className="block w-full px-12 py-8 border-0 border-b-[0.5px] border-ql-hairline bg-transparent text-left font-ql cursor-default aria-[current=true]:bg-ql-highlight"
							>
								<div className="overflow-hidden text-[12.5px] font-semibold text-ellipsis whitespace-nowrap">{message.subject === "" ? t("quickLook.mail.noSubject") : message.subject}</div>
								<div className="overflow-hidden text-[11.5px] text-ql-ink-secondary text-ellipsis whitespace-nowrap">{message.from === "" ? t("quickLook.mail.unknownSender") : message.from}</div>
							</button>
						</li>
					))}
				</ul>
			</nav>
			{mail === null ? <p className="m-auto text-ql-ink-secondary text-[13px]">{t("quickLook.mail.noMessages")}</p> : <MessagePane mail={mail} />}
		</div>
	);
}

function parseSingle(file: PreviewDocument, bytes: Uint8Array): MailMessage | null {
	try {
		if (file.ext === "msg") return parseMsg(bytes);
		return file.ext === "emlx" ? parseEmlx(bytes) : parseMail(bytes);
	} catch {
		return null;
	}
}

/**
 * Email: `eml`, `emlx`, `msg` show one message (headers, sanitized body,
 * attachments); `mbox` lists its messages beside the open one.
 */
export function MailView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t } = useTranslation();
	const { report } = useChrome();
	const bytes = file.bytes;
	const mbox = file.ext === "mbox";
	const mail = useMemo(() => (bytes === null || mbox ? null : parseSingle(file, bytes)), [file, bytes, mbox]);
	useEffect(() => report(mbox ? MBOX_SIZE : MAIL_SIZE, "clamp"), [report, mbox]);
	if (bytes === null || (!mbox && mail === null)) return <FallbackView file={file} note={t("quickLook.mail.readFailed")} />;
	if (mbox) return <MboxPane file={file} bytes={bytes} />;
	return mail === null ? <FallbackView file={file} note={t("quickLook.mail.readFailed")} /> : <div className="flex flex-1 min-h-0 border-t-[0.5px] border-ql-hairline"><MessagePane mail={mail} /></div>;
}
