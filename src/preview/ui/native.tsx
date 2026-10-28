import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { NativePreview, PreviewDocument } from "../shared/contract";
import { rtfToText } from "../shared/rtf";
import { decodeUtf8 } from "../shared/text-sample";
import { ContentsBox } from "./contents";
import { FallbackView } from "./fallback";
import { useChrome, usePanelHeight } from "./chrome";

function nativeOf(file: PreviewDocument, kind: NativePreview["kind"]): NativePreview | null {
	return file.native?.kind === kind ? file.native : null;
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}

export function WeblocView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t } = useTranslation();
	const native = nativeOf(file, "webloc");
	const attach = usePanelHeight(620);
	if (native?.kind !== "webloc") return <FallbackView file={file} note={t("quickLook.native.readFailed")} />;
	return (
		<div ref={attach} className="ql-webloc flex flex-col w-full p-40 gap-20">
			<div className="ql-webloc__title text-[22px] font-semibold select-text">{native.title}</div>
			<div className="flex flex-col gap-7 px-16 py-14 rounded-10 bg-ql-sunk">
				<span className="text-[11px] font-semibold text-ql-ink-secondary">URL</span>
				<span className="ql-webloc__url text-[14px] text-ql-accent break-all select-text">{native.url}</span>
			</div>
		</div>
	);
}

export function WebarchiveView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t } = useTranslation();
	const { report } = useChrome();
	const native = nativeOf(file, "webarchive");
	useEffect(() => report({ width: 900, height: 650 }, "clamp"), [report]);
	if (native?.kind !== "webarchive") return <FallbackView file={file} note={t("quickLook.native.readFailed")} />;
	// The main process has removed active/external content and installed a CSP;
	// the sandbox independently disables script, navigation, forms, and popups.
	return <iframe className="ql-webarchive block flex-1 self-stretch w-full h-full border-0 bg-white" sandbox="" title={file.name} srcDoc={native.html} />;
}

export function RtfdView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t } = useTranslation();
	const native = nativeOf(file, "rtfd");
	const attach = usePanelHeight(640);
	if (native?.kind !== "rtfd") return <FallbackView file={file} note={t("quickLook.native.readFailed")} />;
	return (
		<div ref={attach} className="ql-rtfd flex flex-col w-full min-h-0">
			<pre className="ql-rtfd__text flex-1 min-h-180 overflow-auto box-border self-stretch w-full m-0 px-24 py-20 bg-window text-ink font-mono text-meta leading-[1.55] whitespace-pre-wrap [word-break:break-word] select-text">{rtfToText(decodeUtf8(native.rtf))}</pre>
			<ContentsBox
				kind="archive"
				items={native.attachments.map((name) => ({ name, folder: false, ext: name.split(".").pop() ?? "" }))}
				total={native.attachments.length}
				order={t("quickLook.native.attachments")}
				empty={t("quickLook.native.noAttachments")}
			/>
		</div>
	);
}

export function TextClippingView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t } = useTranslation();
	const native = nativeOf(file, "textclipping");
	if (native?.kind !== "textclipping") return <FallbackView file={file} note={t("quickLook.native.readFailed")} />;
	return <pre className="ql-textclipping box-border self-stretch w-full h-auto m-0 px-24 py-20 bg-window text-ink font-ql text-[14px] leading-[1.55] whitespace-pre-wrap [word-break:break-word] select-text">{native.text}</pre>;
}

export function IconsetView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t } = useTranslation();
	const native = nativeOf(file, "iconset");
	const attach = usePanelHeight(640);
	const [urls, setUrls] = useState<readonly string[]>([]);
	useEffect(() => {
		if (native?.kind !== "iconset") return;
		const next = native.icons.map((icon) => URL.createObjectURL(new Blob([copyBytes(icon.bytes)], { type: "image/png" })));
		setUrls(next);
		return () => {
			for (const url of next) URL.revokeObjectURL(url);
		};
	}, [native]);
	if (native?.kind !== "iconset") return <FallbackView file={file} note={t("quickLook.native.readFailed")} />;
	return (
		<div ref={attach} className="ql-iconset w-full p-20 overflow-auto">
			{native.icons.length === 0 ? (
				<p className="text-center text-[13px] text-ql-ink-secondary">{t("quickLook.native.emptyIconset")}</p>
			) : (
				<div className="grid grid-cols-4 gap-16">
					{native.icons.map((icon, index) => (
						<figure key={icon.name} className="ql-iconset__item flex flex-col items-center gap-7 min-w-0 m-0 p-10 rounded-10 bg-ql-sunk">
							<img className="size-112 object-contain" src={urls[index]} alt={icon.name} draggable={false} />
							<figcaption className="max-w-full overflow-hidden text-[11px] text-ellipsis whitespace-nowrap" title={icon.name}>{icon.name}</figcaption>
						</figure>
					))}
				</div>
			)}
		</div>
	);
}
