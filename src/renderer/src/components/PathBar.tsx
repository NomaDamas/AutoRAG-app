import type { ReactElement, ReactNode } from "react";
import { HardDrive, Home } from "lucide-react";
import { cn } from "../lib/cn";
import type { Crumb } from "../state/paths";
import { kindFromExtension } from "../state/kinds";
import { FileTile } from "./primitives/FileTile";

/** v7 `.pathbar` (proto:.pathbar): macOS path bar docked above the AI dock. */

interface PathSegment {
	readonly key: string;
	readonly label: string;
	/** Null marks the decorative "Macintosh HD" prefix. */
	readonly path: string | null;
	readonly icon: ReactNode;
}

const SEGMENT_CLASS =
	"path-seg inline-flex h-20 min-w-24 flex-[0_1_auto] items-center gap-4 overflow-hidden rounded-4 border-0 bg-transparent px-5 text-badge text-inherit";
const ICON_CLASS = "path-ic grid size-14 flex-none place-items-center text-ink-faint";

function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1) : "";
}

export function PathBar({
	crumbs,
	selectedName,
	onNavigate,
}: {
	readonly crumbs: readonly Crumb[];
	readonly selectedName: string | null;
	readonly onNavigate: (path: string) => void;
}): ReactElement {
	const local = crumbs[0]?.label === "Users";
	const segments: PathSegment[] = [];
	if (local) {
		segments.push({ key: "$disk", label: "Macintosh HD", path: null, icon: <HardDrive size={14} strokeWidth={1.8} /> });
	}
	crumbs.forEach((crumb, index) => {
		const home = local && index === 1;
		segments.push({
			key: crumb.path,
			label: crumb.label,
			path: crumb.path,
			icon: home ? <Home size={14} strokeWidth={1.8} /> : <FileTile kind="folder" size={16} />,
		});
	});
	if (selectedName !== null) {
		segments.push({
			key: "$file",
			label: selectedName,
			path: null,
			icon: <FileTile kind={kindFromExtension(extensionOf(selectedName))} size={16} />,
		});
	}
	return (
		<nav
			className="pathbar flex h-24 flex-none items-center gap-1 overflow-hidden whitespace-nowrap border-t border-border bg-chrome px-8 text-badge text-ink-body"
			aria-label="Path"
		>
			{segments.map((segment, index) => (
				<span key={segment.key} className="flex min-w-0 flex-[0_1_auto] items-center gap-1">
					{index > 0 ? <span className="path-sep flex-none px-1 text-meta text-ink-faint">›</span> : null}
					<button
						type="button"
						className={cn(SEGMENT_CLASS, segment.path !== null && "cursor-pointer hover:bg-hover hover:text-ink")}
						title={segment.path ?? segment.label}
						onClick={segment.path === null ? undefined : () => onNavigate(segment.path ?? "")}
					>
						<span className={ICON_CLASS}>{segment.icon}</span>
						<span className="path-name min-w-0 overflow-hidden text-ellipsis">{segment.label}</span>
					</button>
				</span>
			))}
		</nav>
	);
}
