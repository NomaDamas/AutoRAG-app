/**
 * A local file or folder the model named with `[file:<path>]` and the librarian
 * did not turn into a numbered citation (a folder, or a file it could not open).
 * It shows as the file's tile and name instead of the marker's raw text, and
 * clicking it reveals the item in the Finder like an evidence title does.
 */

import type { ReactElement } from "react";
import { cn } from "../lib/cn";
import { evidenceKind } from "../state/evidence";
import type { FileKind } from "../state/kinds";
import { basename, isAbsolutePath } from "../state/paths";
import { FileTile } from "./primitives/FileTile";

const CHIP =
	"inline-flex max-w-full items-center gap-4 rounded-6 border border-divider bg-window py-1 pl-3 pr-6 align-[-4px] text-caption font-medium leading-[16px] text-ink";

/** A name with no extension, or a path ending in a separator, names a folder. */
function mentionKind(path: string): FileKind {
	const trimmed = path.replace(/[\\/]+$/u, "");
	const name = basename(trimmed);
	return trimmed !== path || !/\.[A-Za-z0-9]{1,6}$/u.test(name) ? "folder" : evidenceKind(name);
}

export function FileMention({ path, onOpen }: { readonly path: string; readonly onOpen: (path: string) => void }): ReactElement {
	const trimmed = path.replace(/[\\/]+$/u, "");
	const name = basename(trimmed) === "" ? path : basename(trimmed);
	const content = (
		<>
			<FileTile kind={mentionKind(path)} size={16} />
			<span className="min-w-0 truncate">{name}</span>
		</>
	);
	if (!isAbsolutePath(trimmed)) {
		return (
			<span className={CHIP} title={path} data-file-mention={path}>
				{content}
			</span>
		);
	}
	return (
		<button
			type="button"
			className={cn(CHIP, "cursor-pointer transition-colors duration-(--dur-color) ease-out hover:bg-hover")}
			title={path}
			data-file-mention={path}
			onClick={() => onOpen(trimmed)}
		>
			{content}
		</button>
	);
}
