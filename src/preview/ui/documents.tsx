import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { renderAsync } from "docx-preview";
import type { PreviewDocument } from "../shared/contract";
import { readSheetPreview } from "../shared/sheet";
import { rtfToText } from "../shared/rtf";
import { decodeUtf8 } from "../shared/text-sample";
import { FallbackView, Status } from "./fallback";

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}

export function DocxView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t } = useTranslation();
	const bytes = file.bytes;
	const [srcdoc, setSrcdoc] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (bytes === null) return;
		let cancelled = false;
		const host = document.createElement("div");
		renderAsync(new Blob([copyBytes(bytes)]), host, host, { inWrapper: true, breakPages: true })
			.then(() => {
				if (cancelled) return;
				setSrcdoc(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#fff}</style>${host.innerHTML}`);
			})
			.catch((caught: unknown) => {
				if (cancelled) return;
				setError(caught instanceof Error ? caught.message : t("quickLook.documents.openFailed"));
			});
		return () => {
			cancelled = true;
		};
	}, [bytes]);
	if (bytes === null) return <FallbackView file={file} note={t("quickLook.documents.readFailed")} />;
	if (error !== null) return <FallbackView file={file} note={error} />;
	if (srcdoc === null) return <Status>{t("quickLook.status.loading")}</Status>;
	return <iframe className="ql__frame flex-1 self-stretch w-full h-full border-0 bg-window" sandbox="" title={file.name} srcDoc={srcdoc} />;
}

export function SheetView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t } = useTranslation();
	const bytes = file.bytes;
	const [sheet, setSheet] = useState(0);
	// Parsed once per file and sheet: a re-render must not read the workbook again.
	const read = useMemo(() => {
		if (bytes === null) return null;
		try {
			return { ok: true as const, preview: readSheetPreview(bytes, sheet) };
		} catch (caught) {
			return { ok: false as const, message: caught instanceof Error ? caught.message : t("quickLook.documents.sheetOpenFailed") };
		}
	}, [bytes, sheet, t]);
	if (read === null) return <FallbackView file={file} note={t("quickLook.documents.sheetReadFailed")} />;
	if (!read.ok) return <FallbackView file={file} note={read.message} />;
	const { names, rows } = read.preview;
	if (names.length === 0) return <FallbackView file={file} note={t("quickLook.documents.sheetMissing")} />;
	return (
		<>
			<div className="ql__tablewrap box-border self-stretch w-full h-auto m-0 p-16">
				<table className="ql__table border-collapse bg-window text-meta [&_th]:max-w-[240px] [&_td]:max-w-[240px] [&_th]:px-10 [&_td]:px-10 [&_th]:py-6 [&_td]:py-6 [&_th]:overflow-hidden [&_td]:overflow-hidden [&_th]:border [&_td]:border [&_th]:border-divider [&_td]:border-divider [&_th]:text-ellipsis [&_td]:text-ellipsis [&_th]:whitespace-nowrap [&_td]:whitespace-nowrap [&_th]:bg-subtle [&_th]:font-semibold">
					<tbody>
						{rows.map((row, rowIndex) => (
							<tr key={rowIndex}>
								{row.map((cell, cellIndex) =>
									rowIndex === 0 ? <th key={cellIndex}>{cell}</th> : <td key={cellIndex}>{cell}</td>,
								)}
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{names.length > 1 ? (
				<div className="ql__pager flex flex-none self-stretch items-center justify-center gap-12 h-[40px] border-t border-divider bg-ql-sunk text-ink-muted text-meta [&_button]:h-icon-sm [&_button]:px-10 [&_button]:border [&_button]:border-border [&_button]:rounded-6 [&_button]:bg-window [&_button]:text-ink [&_button]:disabled:text-ink-faint">
					<button type="button" disabled={sheet <= 0} onClick={() => setSheet((current) => current - 1)}>
						{t("quickLook.documents.previous")}
					</button>
					<span>{names[sheet] ?? ""}</span>
					<button type="button" disabled={sheet >= names.length - 1} onClick={() => setSheet((current) => current + 1)}>
						{t("quickLook.documents.next")}
					</button>
				</div>
			) : null}
		</>
	);
}

export function RtfView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t } = useTranslation();
	if (file.bytes === null) return <FallbackView file={file} note={t("quickLook.documents.readFailed")} />;
	return (
		<pre className="ql__pre box-border self-stretch w-full h-auto m-0 px-24 py-20 bg-window text-ink font-mono text-meta leading-[1.55] whitespace-pre-wrap [word-break:break-word] select-text">
			{rtfToText(decodeUtf8(file.bytes))}
		</pre>
	);
}
