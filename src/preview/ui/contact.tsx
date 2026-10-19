import { useEffect, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { PreviewDocument } from "../shared/contract";
import { parseVcf, type Contact, type ContactValue } from "../shared/vcf";
import { useChrome } from "./chrome";
import { FallbackView } from "./fallback";

const CONTACT_WIDTH = 560;

function Rows({ label, values }: { readonly label: string; readonly values: readonly ContactValue[] }): ReactElement | null {
	if (values.length === 0) return null;
	return (
		<>
			{values.map((item, index) => (
				<div key={index} className="flex gap-12 text-[13px] leading-[1.7]">
					<dt className="flex-none w-72 text-right text-ql-ink-secondary">{index === 0 ? label : ""}</dt>
					<dd className="flex-1 min-w-0 m-0 break-words select-text">
						{item.value}
						{item.type === "" ? null : <span className="ml-8 text-[11.5px] text-ql-ink-secondary">{item.type}</span>}
					</dd>
				</div>
			))}
		</>
	);
}

function Card({ contact }: { readonly contact: Contact }): ReactElement {
	const { t } = useTranslation();
	const name = contact.name === "" ? t("quickLook.contact.noName") : contact.name;
	return (
		<section className="px-32 py-24 border-b-[0.5px] border-ql-hairline last:border-b-0">
			<div className="flex items-center gap-20 mb-16">
				{contact.photo === null ? (
					<div className="grid flex-none place-items-center w-72 h-72 rounded-full bg-ql-sunk text-[28px] font-semibold text-ql-ink-secondary">{[...name][0] ?? ""}</div>
				) : (
					<img className="flex-none w-72 h-72 rounded-full object-cover" src={contact.photo} alt={t("quickLook.contact.photo", { name })} />
				)}
				<div className="flex flex-col gap-2 min-w-0">
					<div className="text-[22px] font-bold tracking-[-0.01em] break-words select-text">{name}</div>
					{contact.org === "" && contact.title === "" ? null : <div className="text-[13px] text-ql-ink-secondary select-text">{[contact.title, contact.org].filter((part) => part !== "").join(" · ")}</div>}
				</div>
			</div>
			<dl className="flex flex-col m-0">
				<Rows label={t("quickLook.contact.phone")} values={contact.phones} />
				<Rows label={t("quickLook.contact.email")} values={contact.emails} />
				<Rows label={t("quickLook.contact.address")} values={contact.addresses} />
				<Rows label={t("quickLook.contact.note")} values={contact.note === "" ? [] : [{ type: "", value: contact.note }]} />
			</dl>
		</section>
	);
}

/** vCard files: one contact card per `BEGIN:VCARD`, with the photo as an inline image. */
export function ContactView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t, i18n } = useTranslation();
	const { report } = useChrome();
	const contacts = useMemo(() => (file.bytes === null ? null : parseVcf(file.bytes)), [file.bytes]);
	useEffect(() => report({ width: CONTACT_WIDTH, height: Math.min(640, 150 + (contacts?.length ?? 1) * 260) }, "clamp"), [report, contacts]);
	if (contacts === null) return <FallbackView file={file} note={t("quickLook.contact.readFailed")} />;
	if (contacts.length === 0) return <FallbackView file={file} note={t("quickLook.contact.empty")} />;
	return (
		<div className="flex flex-col flex-1 min-h-0 border-t-[0.5px] border-ql-hairline bg-ql-paper">
			{contacts.length > 1 ? <div className="flex-none px-32 py-8 text-[11.5px] text-ql-ink-secondary border-b-[0.5px] border-ql-hairline">{t("quickLook.contact.contacts", { count: contacts.length.toLocaleString(i18n.language) })}</div> : null}
			<div className="flex-1 min-h-0 overflow-auto">
				{contacts.map((contact, index) => (
					<Card key={index} contact={contact} />
				))}
			</div>
		</div>
	);
}
