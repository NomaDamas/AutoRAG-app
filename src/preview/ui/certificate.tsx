import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { EXTENDED_KEY_USAGE_NAMES } from "../shared/certificate";
import type { CertificateEntry, CertificateInfo, CertificateList, CertificatePreview, PreviewDocument } from "../shared/contract";
import { formatFinderDate, formatFinderSize } from "../shared/format";
import { describeExtension } from "../shared/registry";
import { useChrome, useHiddenTitle, usePanelHeight } from "./chrome";
import { Status } from "./fallback";
import { FileGlyph, LockIcon } from "./icons";

const CERTIFICATE_SIZE = { width: 700, height: 640 } as const;
const CONTAINER_WIDTH = 620;

type Loaded = { readonly path: string; readonly preview: CertificatePreview } | { readonly path: string; readonly error: string };

function Row({ label, children, mono = false }: { readonly label: string; readonly children: ReactNode; readonly mono?: boolean }): ReactElement {
	return (
		<div className="flex gap-12 text-[12.5px] leading-[1.6]">
			<dt className="flex-none w-112 text-right text-ql-ink-secondary">{label}</dt>
			<dd className={`flex-1 min-w-0 m-0 break-words select-text ${mono ? "font-ql-mono text-[11.5px]" : ""}`}>{children}</dd>
		</div>
	);
}

function StatusBadge({ status }: { readonly status: CertificateInfo["status"] }): ReactElement | null {
	const { t } = useTranslation();
	if (status === "valid") return null;
	const tone = status === "expired" ? "bg-danger-bg text-danger-text" : "bg-warn-bg text-warn-text";
	return <span className={`flex-none px-8 py-1 rounded-5 text-[11px] font-semibold ${tone}`}>{t(`quickLook.certificate.status.${status}`)}</span>;
}

function Certificate({ certificate }: { readonly certificate: CertificateInfo }): ReactElement {
	const { t } = useTranslation();
	const keyText =
		certificate.curve !== null
			? `${certificate.keyAlgorithm} (${certificate.curve})`
			: certificate.keyBits !== null
				? `${certificate.keyAlgorithm} ${certificate.keyBits}`
				: certificate.keyAlgorithm;
	const usages = certificate.keyUsage.map((name) => t(`quickLook.certificate.usage.${name}`));
	const extended = certificate.extendedKeyUsage.map((oid) => {
		const name = EXTENDED_KEY_USAGE_NAMES[oid];
		return name === undefined ? oid : t(`quickLook.certificate.eku.${name}`);
	});
	return (
		<section className="px-28 py-18 border-b-[0.5px] border-ql-hairline last:border-b-0" data-certificate-status={certificate.status}>
			<div className="flex items-center gap-10 mb-10">
				<div className="flex-1 min-w-0 text-[17px] font-bold tracking-[-0.01em] break-words select-text">{certificate.commonName}</div>
				{certificate.ca ? <span className="flex-none px-8 py-1 rounded-5 bg-ql-sunk text-[11px] font-semibold text-ql-ink-secondary">{t("quickLook.certificate.ca")}</span> : null}
				<StatusBadge status={certificate.status} />
			</div>
			<dl className="flex flex-col m-0">
				<Row label={t("quickLook.certificate.subject")}>{certificate.subject}</Row>
				<Row label={t("quickLook.certificate.issuer")}>{certificate.issuer}</Row>
				<Row label={t("quickLook.certificate.serial")} mono>
					{certificate.serial}
				</Row>
				<Row label={t("quickLook.certificate.notBefore")}>{formatFinderDate(certificate.notBefore, true)}</Row>
				<Row label={t("quickLook.certificate.notAfter")}>
					{formatFinderDate(certificate.notAfter, true)}
					{certificate.status === "valid" ? null : <span className="ml-8 text-[11.5px] text-ql-ink-secondary">({t(`quickLook.certificate.status.${certificate.status}`)})</span>}
				</Row>
				<Row label={t("quickLook.certificate.signature")}>{certificate.signatureAlgorithm}</Row>
				<Row label={t("quickLook.certificate.publicKey")}>{keyText}</Row>
				{certificate.subjectAltNames.length === 0 ? null : (
					<Row label={t("quickLook.certificate.altNames")}>
						{certificate.subjectAltNames.map((name) => (
							<div key={name}>{name}</div>
						))}
					</Row>
				)}
				{usages.length === 0 ? null : <Row label={t("quickLook.certificate.keyUsage")}>{usages.join(", ")}</Row>}
				{extended.length === 0 ? null : <Row label={t("quickLook.certificate.extendedKeyUsage")}>{extended.join(", ")}</Row>}
				<Row label="SHA-256" mono>
					{certificate.sha256}
				</Row>
				<Row label="SHA-1" mono>
					{certificate.sha1}
				</Row>
			</dl>
		</section>
	);
}

function EntryView({ entry }: { readonly entry: CertificateEntry }): ReactElement {
	const { t } = useTranslation();
	switch (entry.kind) {
		case "certificate":
			return <Certificate certificate={entry.certificate} />;
		case "privateKey":
			return (
				<section className="flex items-center gap-12 px-28 py-14 border-b-[0.5px] border-ql-hairline last:border-b-0">
					<span className="flex-none text-ql-ink-secondary">
						<LockIcon />
					</span>
					<div className="flex flex-col min-w-0">
						<div className="ql-certificate__key text-[13px] font-semibold font-ql-mono break-words select-text">{entry.label}</div>
						<div className="text-[12px] text-ql-ink-secondary">
							{t("quickLook.certificate.keyHidden")}
							{entry.encrypted === null ? "" : ` · ${t(entry.encrypted ? "quickLook.certificate.keyEncrypted" : "quickLook.certificate.keyPlain")}`}
						</div>
					</div>
				</section>
			);
		case "invalid":
			return (
				<section className="px-28 py-14 border-b-[0.5px] border-ql-hairline last:border-b-0">
					<div className="text-[13px] font-semibold font-ql-mono break-words select-text">{entry.label}</div>
					<div className="text-[12px] text-ql-ink-secondary">{t("quickLook.certificate.unreadableBlock")}</div>
				</section>
			);
		case "other":
			return (
				<section className="px-28 py-14 border-b-[0.5px] border-ql-hairline last:border-b-0">
					<div className="text-[13px] font-semibold font-ql-mono break-words select-text">{entry.label}</div>
				</section>
			);
	}
}

function CertificatePanel({ list }: { readonly list: CertificateList }): ReactElement {
	const { t, i18n } = useTranslation();
	const { report } = useChrome();
	useEffect(() => report(CERTIFICATE_SIZE, "clamp"), [report]);
	const certificates = list.entries.filter((entry) => entry.kind === "certificate").length;
	return (
		<div className="ql-certificate-list flex flex-col flex-1 min-h-0 border-t-[0.5px] border-ql-hairline bg-ql-paper">
			<div className="ql-certificate__count flex-none px-28 py-8 text-[11.5px] text-ql-ink-secondary border-b-[0.5px] border-ql-hairline">
				{certificates === 1 ? t("quickLook.certificate.countOne") : t("quickLook.certificate.countMany", { count: certificates.toLocaleString(i18n.language) })}
				{list.omitted === 0 ? null : ` · ${t("quickLook.certificate.omitted", { count: list.omitted.toLocaleString(i18n.language) })}`}
				{list.truncated ? ` · ${t("quickLook.certificate.truncated")}` : ""}
			</div>
			<div className="flex-1 min-h-0 overflow-auto">
				{list.entries.map((entry, index) => (
					<EntryView key={index} entry={entry} />
				))}
			</div>
		</div>
	);
}

/** The panel of a file that is not a certificate list: its glyph, name, kind, size and date, and one sentence saying what the OS and this app do with it. */
function LabelledPanel({ file, note, locked = false }: { readonly file: PreviewDocument; readonly note: string; readonly locked?: boolean }): ReactElement {
	const { t } = useTranslation();
	useHiddenTitle();
	const attach = usePanelHeight(CONTAINER_WIDTH);
	return (
		<div ref={attach} className="ql-certificate flex flex-col w-full pb-24">
			<div className="flex flex-none items-center gap-34 h-232 pt-4 pr-40 pl-44 box-border">
				<FileGlyph label={file.ext === "" ? "FILE" : file.ext.slice(0, 4).toUpperCase()} />
				<div className="flex flex-col flex-1 gap-3 min-w-0">
					<div className="ql-certificate__name mb-4 overflow-hidden text-[22px] font-bold tracking-[-0.01em] text-ellipsis whitespace-nowrap select-text">{file.name}</div>
					<div className="text-[14px] text-ql-ink-secondary">{describeExtension(file.ext)}</div>
					<div className="text-[14px] text-ql-ink-secondary">{formatFinderSize(file.size)}</div>
					<div className="text-[14px] text-ql-ink-secondary">{t("quickLook.fallback.lastModified", { date: formatFinderDate(file.modifiedAt, true) })}</div>
					<div className="ql__note ql-certificate__note flex items-start gap-6 mt-6 text-[12.5px] text-ql-ink-secondary">
						{locked ? (
							<span className="flex-none mt-2">
								<LockIcon />
							</span>
						) : null}
						<span>{note}</span>
					</div>
				</div>
			</div>
		</div>
	);
}

/**
 * Certificates and key containers. The main process decodes the file with
 * `node:crypto` and sends back fields only (never a private key's body, never
 * more than the first bytes of the file); this page draws them. PKCS #12
 * bundles and keychains are encrypted stores, so they get a labelled panel.
 */
export function CertificateView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t } = useTranslation();
	const { bridge, report } = useChrome();
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	useEffect(() => {
		let cancelled = false;
		bridge.certificatePreview(file.path).then(
			(preview) => {
				if (!cancelled) setLoaded({ path: file.path, preview });
			},
			(caught: unknown) => {
				if (!cancelled) setLoaded({ path: file.path, error: caught instanceof Error ? caught.message : t("quickLook.certificate.readFailed") });
			},
		);
		return () => {
			cancelled = true;
		};
	}, [bridge, file.path, t]);
	const waiting = loaded === null || loaded.path !== file.path;
	useEffect(() => {
		if (waiting) report(CERTIFICATE_SIZE, "clamp");
	}, [waiting, report]);
	if (waiting) return <Status>{t("quickLook.status.loading")}</Status>;
	if ("error" in loaded) return <LabelledPanel file={file} note={loaded.error} />;
	const { preview } = loaded;
	switch (preview.kind) {
		case "certificates":
			return <CertificatePanel list={preview} />;
		case "container":
			if (!preview.recognized) return <LabelledPanel file={file} note={t(`quickLook.certificate.notContainer.${preview.container}`)} />;
			return <LabelledPanel file={file} locked note={t(`quickLook.certificate.container.${preview.container}`)} />;
		case "unreadable":
			return <LabelledPanel file={file} note={t(`quickLook.certificate.unreadable.${preview.reason}`)} />;
	}
}
