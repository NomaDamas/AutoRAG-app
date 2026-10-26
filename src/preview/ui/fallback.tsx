import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { FileDetails, PreviewDocument } from "../shared/contract";
import { formatFinderDate, formatFinderSize } from "../shared/format";
import { describeExtension } from "../shared/registry";
import { useChrome, useHiddenTitle, usePanelHeight } from "./chrome";
import { ChevronIcon, FileGlyph } from "./icons";

/** Panel width of the "Other" and error panels, from the reference. */
const OTHER_WIDTH = 620;
const ERROR_SIZE = { width: 420, height: 120 } as const;

const MINI_BUTTON =
	"flex-none h-22 px-8 border-0 rounded-5 bg-ql-button text-ql-ink font-ql text-[11px] font-medium whitespace-nowrap cursor-default hover:bg-ql-button-hover";

/** Reveal-in-file-manager label per platform; unknown platforms fall back to "folder". */
const REVEAL_LABEL_KEYS = {
	darwin: "quickLook.fallback.revealFinder",
	win32: "quickLook.fallback.revealExplorer",
} as const;
type RevealLabelKey = (typeof REVEAL_LABEL_KEYS)[keyof typeof REVEAL_LABEL_KEYS] | "quickLook.fallback.revealFolder";

function revealLabelKey(platform: string): RevealLabelKey {
	const key = REVEAL_LABEL_KEYS[platform as keyof typeof REVEAL_LABEL_KEYS];
	return key ?? "quickLook.fallback.revealFolder";
}

const BINARY_LABEL_KEYS = { platform: "quickLook.binary.platform", format: "quickLook.binary.format" } as const;

function DetailRow({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactElement {
	return (
		<div className="flex gap-12 text-[12px] leading-[1.5]">
			<dt className="flex-none w-72 text-right text-ql-ink-secondary">{label}</dt>
			<dd className="flex flex-1 items-center gap-8 min-w-0 m-0">{children}</dd>
		</div>
	);
}

function Details({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t } = useTranslation();
	const { bridge } = useChrome();
	const [details, setDetails] = useState<FileDetails | null>(null);
	const [hash, setHash] = useState<string | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		let cancelled = false;
		const fail = (caught: unknown): void => {
			if (!cancelled) setFailure(caught instanceof Error ? caught.message : String(caught));
		};
		bridge.details(file.path).then((next) => {
			if (!cancelled) setDetails(next);
		}, fail);
		bridge.sha256(file.path).then((next) => {
			if (!cancelled) setHash(next);
		}, fail);
		return () => {
			cancelled = true;
		};
	}, [bridge, file.path]);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [copied]);
	const pending = failure ?? t("quickLook.fallback.loading");
	return (
		<dl className="ql-other__details flex flex-col gap-7 mx-24 my-0 px-16 py-14 rounded-10 bg-ql-sunk select-text">
			<DetailRow label={t("quickLook.fallback.createdAt")}>{details === null ? pending : formatFinderDate(details.createdAt, true)}</DetailRow>
			<DetailRow label={t("quickLook.fallback.location")}>
				<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{details === null ? pending : details.location.join(" › ")}</span>
				<button type="button" className={MINI_BUTTON} onClick={() => void bridge.request("reveal")}>
					{t(revealLabelKey(bridge.platform))}
				</button>
			</DetailRow>
			<DetailRow label="SHA-256">
				<span className="min-w-0 overflow-hidden font-ql-mono text-[11.5px] text-ellipsis whitespace-nowrap">{hash ?? (failure ?? t("quickLook.fallback.computing"))}</span>
				{hash === null ? null : (
					<button
						type="button"
						className={MINI_BUTTON}
						onClick={() => {
							void bridge.copyText(hash).then(() => setCopied(true));
						}}
					>
						{copied ? t("quickLook.fallback.copied") : t("quickLook.fallback.copy")}
					</button>
				)}
			</DetailRow>
			{details?.binary == null ? null : <DetailRow label={t(BINARY_LABEL_KEYS[details.binary.label])}>{details.binary.value}</DetailRow>}
		</dl>
	);
}

/**
 * The "Other" panel for files nothing can render: a large page glyph with the
 * file's name, kind, size, and date, and a disclosure for creation date,
 * location, checksum, and what a binary is. Viewers that fail fall back to it
 * with `note` saying why. `art` replaces the page glyph with the file's own
 * picture (a Google Drive document's thumbnail).
 */
export function FallbackView({ file, note, art }: { readonly file: PreviewDocument; readonly note?: string | undefined; readonly art?: ReactNode }): ReactElement {
	const { t } = useTranslation();
	useHiddenTitle();
	const attach = usePanelHeight(OTHER_WIDTH);
	const [open, setOpen] = useState(false);
	const label = file.ext === "" ? "FILE" : file.ext.slice(0, 4).toUpperCase();
	return (
		<div ref={attach} className="ql-other flex flex-col w-full pb-12">
			<div className="flex flex-none items-center gap-34 h-232 pt-4 pr-40 pl-44 box-border">
				{art ?? <FileGlyph label={label} />}
				<div className="flex flex-col flex-1 gap-3 min-w-0">
					<div className="ql-other__name mb-4 overflow-hidden text-[22px] font-bold tracking-[-0.01em] text-ellipsis whitespace-nowrap select-text">{file.name}</div>
					<div className="text-[14px] text-ql-ink-secondary">{describeExtension(file.ext)}</div>
					<div className="text-[14px] text-ql-ink-secondary">{formatFinderSize(file.size)}</div>
					<div className="text-[14px] text-ql-ink-secondary">{t("quickLook.fallback.lastModified", { date: formatFinderDate(file.modifiedAt, true) })}</div>
					{note === undefined ? null : <div className="ql__note mt-4 text-[12px] text-ql-ink-secondary">{note}</div>}
					<div className="mt-10">
						<button
							type="button"
							className="ql-other__more inline-flex items-center gap-4 h-24 -ml-4 pl-4 pr-8 border-0 rounded-6 bg-transparent text-ql-accent font-ql text-[12.5px] font-medium cursor-default hover:bg-ql-button"
							aria-expanded={open}
							onClick={() => setOpen((current) => !current)}
						>
							<ChevronIcon open={open} />
							{t("quickLook.fallback.moreDetails")}
						</button>
					</div>
				</div>
			</div>
			{open ? <Details file={file} /> : null}
		</div>
	);
}

/** A file that could not be read at all (missing, unreadable folder). */
export function ErrorView({ message }: { readonly message: string }): ReactElement {
	const { report } = useChrome();
	useEffect(() => report(ERROR_SIZE, "clamp"), [report]);
	return (
		<div className="ql-error flex flex-1 items-center justify-center p-24 text-center">
			<p className="m-0 text-[14px] text-ql-ink-secondary">{message}</p>
		</div>
	);
}

export function Status({ children }: { readonly children: string }): ReactElement {
	return <p className="ql__status m-auto text-ql-ink-secondary text-[13px]">{children}</p>;
}
