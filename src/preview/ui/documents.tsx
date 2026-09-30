import { useEffect, useRef, useState, type ReactElement } from "react";
import { renderAsync } from "docx-preview";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { read, utils } from "xlsx";
import { previewStreamUrl, type PreviewDocument } from "../shared/contract";
import { FallbackView, Status } from "./fallback";

let workerReady = false;

function ensurePdfWorker(): void {
	if (workerReady) return;
	GlobalWorkerOptions.workerSrc = workerUrl;
	workerReady = true;
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}

export function PdfView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const pdfRef = useRef<PDFDocumentProxy | null>(null);
	const [page, setPage] = useState(1);
	const [count, setCount] = useState(0);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		ensurePdfWorker();
		let cancelled = false;
		const task =
			file.bytes === null
				? getDocument({ url: previewStreamUrl(file.path) })
				: getDocument({ data: copyBytes(file.bytes) });
		task.promise
			.then((pdf) => {
				if (cancelled) return;
				pdfRef.current = pdf;
				setCount(pdf.numPages);
				setPage(1);
			})
			.catch((caught: unknown) => {
				if (!cancelled) setError(caught instanceof Error ? caught.message : "PDF를 열 수 없습니다");
			});
		return () => {
			cancelled = true;
			pdfRef.current = null;
			void task.destroy();
		};
	}, [file]);

	useEffect(() => {
		const pdf = pdfRef.current;
		const host = hostRef.current;
		if (pdf === null || host === null || count === 0) return;
		let cancelled = false;
		void pdf
			.getPage(page)
			.then((pdfPage) => {
				if (cancelled) return;
				const width = Math.max(host.clientWidth - 32, 320);
				const base = pdfPage.getViewport({ scale: 1 });
				const viewport = pdfPage.getViewport({ scale: Math.min(2, width / base.width) });
				const canvas = document.createElement("canvas");
				canvas.width = Math.floor(viewport.width);
				canvas.height = Math.floor(viewport.height);
				canvas.className = "ql__canvas";
				host.replaceChildren(canvas);
				return pdfPage.render({ canvas, viewport }).promise;
			})
			.catch((caught: unknown) => {
				if (!cancelled) setError(caught instanceof Error ? caught.message : "PDF 페이지를 그리지 못했습니다");
			});
		return () => {
			cancelled = true;
		};
	}, [page, count]);

	if (error !== null) return <FallbackView file={file} note={error} />;
	return (
		<>
			<div ref={hostRef} className="ql__canvas-host">
				{count === 0 ? <Status>불러오는 중</Status> : null}
			</div>
			{count > 1 ? (
				<div className="ql__pager">
					<button type="button" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>
						이전
					</button>
					<span>
						{page} / {count}
					</span>
					<button type="button" disabled={page >= count} onClick={() => setPage((current) => current + 1)}>
						다음
					</button>
				</div>
			) : null}
		</>
	);
}

export function DocxView({ file }: { readonly file: PreviewDocument }): ReactElement {
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
				setError(caught instanceof Error ? caught.message : "문서를 열 수 없습니다");
			});
		return () => {
			cancelled = true;
		};
	}, [bytes]);
	if (bytes === null) return <FallbackView file={file} note="문서를 읽지 못했습니다" />;
	if (error !== null) return <FallbackView file={file} note={error} />;
	if (srcdoc === null) return <Status>불러오는 중</Status>;
	return <iframe className="ql__frame" sandbox="" title={file.name} srcDoc={srcdoc} />;
}

function cellText(cell: unknown): string {
	if (cell === null || cell === undefined) return "";
	if (typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean") return String(cell);
	return "";
}

export function SheetView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const bytes = file.bytes;
	const [sheet, setSheet] = useState(0);
	if (bytes === null) return <FallbackView file={file} note="시트를 읽지 못했습니다" />;
	let names: readonly string[] = [];
	let rows: readonly (readonly string[])[] = [];
	try {
		const book = read(copyBytes(bytes), { type: "array" });
		names = book.SheetNames;
		const name = names[sheet] ?? names[0];
		const grid = name === undefined ? undefined : book.Sheets[name];
		if (grid !== undefined) {
			const table: unknown = utils.sheet_to_json(grid, { header: 1, raw: false, blankrows: false });
			if (Array.isArray(table)) {
				rows = table.slice(0, 100).map((row) => (Array.isArray(row) ? row.slice(0, 20).map(cellText) : []));
			}
		}
	} catch (caught) {
		const message = caught instanceof Error ? caught.message : "시트를 열 수 없습니다";
		return <FallbackView file={file} note={message} />;
	}
	if (names.length === 0) return <FallbackView file={file} note="시트가 없습니다" />;
	return (
		<>
			<div className="ql__tablewrap">
				<table className="ql__table">
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
				<div className="ql__pager">
					<button type="button" disabled={sheet <= 0} onClick={() => setSheet((current) => current - 1)}>
						이전
					</button>
					<span>{names[sheet] ?? ""}</span>
					<button type="button" disabled={sheet >= names.length - 1} onClick={() => setSheet((current) => current + 1)}>
						다음
					</button>
				</div>
			) : null}
		</>
	);
}
