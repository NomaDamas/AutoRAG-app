import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { BundleSummary, FolderSize } from "../shared/contract";
import { formatFinderDate, formatFinderSize } from "../shared/format";
import { describeExtension } from "../shared/registry";
import { useChrome, useHiddenTitle, usePanelHeight } from "./chrome";
import { FileGlyph } from "./icons";

/** Panel width of the app panel, the "Other" panel it shares its shape with. */
const BUNDLE_WIDTH = 620;

/**
 * The application panel: the app's own icon with its name, kind, total size,
 * and date — what Finder's Quick Look shows for a `.app`, instead of listing
 * the bundle's `Contents/` the way a folder panel does. The size arrives after
 * the same bounded walk the folder panel uses, and the icon is the OS's own
 * rendering at the preview tier.
 */
export function BundleView({ bundle }: { readonly bundle: BundleSummary }): ReactElement {
	const { t } = useTranslation();
	useHiddenTitle();
	const { bridge } = useChrome();
	const attach = usePanelHeight(BUNDLE_WIDTH);
	const [size, setSize] = useState<FolderSize | null>(null);
	useEffect(() => {
		let cancelled = false;
		bridge.folderSize(bundle.path).then(
			(next) => {
				if (!cancelled) setSize(next);
			},
			(caught: unknown) => {
				if (!cancelled && !(caught instanceof Error)) throw caught;
			},
		);
		return () => {
			cancelled = true;
		};
	}, [bridge, bundle.path]);
	return (
		<div ref={attach} className="ql-bundle flex flex-col w-full">
			<div className="flex flex-none items-center gap-36 h-200 pr-40 pl-48">
				{bundle.iconUrl === null ? (
					<FileGlyph label="APP" />
				) : (
					<img
						className="ql-bundle__icon flex-none size-176 object-contain [filter:drop-shadow(0_3px_6px_rgba(0,0,0,0.18))]"
						src={bundle.iconUrl}
						alt=""
						aria-hidden="true"
						draggable={false}
					/>
				)}
				<div className="flex flex-col flex-1 gap-3 min-w-0">
					<div className="ql-bundle__name mb-4 overflow-hidden text-[22px] font-bold tracking-[-0.01em] text-ellipsis whitespace-nowrap select-text">{bundle.name}</div>
					<div className="text-[14px] text-ql-ink-secondary">{describeExtension("app")}</div>
					{size === null ? null : (
						<div className="ql-bundle__size text-[14px] text-ql-ink-secondary">
							{formatFinderSize(size.bytes)}
							{size.complete ? "" : "+"}
						</div>
					)}
					<div className="text-[14px] text-ql-ink-secondary">{t("quickLook.fallback.lastModified", { date: formatFinderDate(bundle.modifiedAt, false) })}</div>
				</div>
			</div>
		</div>
	);
}
