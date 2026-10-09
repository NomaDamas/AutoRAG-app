import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { OsLaunchRequest, OsRendererRequest } from "../shared/os-request-contract";
import type { ChatAttachment } from "../shared/search-contract";

export interface OsRequestServiceDeps {
	/** What `path` is on disk right now; null when it is gone or unreadable. */
	readonly kindOf: (path: string) => Promise<"file" | "folder" | null>;
	/** Called after a request is queued, so the window can come forward and drain it. */
	readonly onQueued: () => void;
}

export interface OsRequestService {
	/** Check the paths and queue the request; a request with no surviving path queues nothing. */
	push(request: OsLaunchRequest): Promise<void>;
	/** Everything queued so far, oldest first; the queue is empty afterwards. */
	take(): readonly OsRendererRequest[];
}

export async function diskKindOf(path: string): Promise<"file" | "folder" | null> {
	try {
		return (await stat(path)).isDirectory() ? "folder" : "file";
	} catch {
		return null;
	}
}

/**
 * Requests from the OS file menu wait here until the renderer takes them: a
 * cold start queues its own launch request before any window has loaded.
 * Paths are checked on the disk first, so a stale or forged entry never
 * becomes an attachment.
 */
export function createOsRequestService(deps: OsRequestServiceDeps): OsRequestService {
	const queue: OsRendererRequest[] = [];
	return {
		async push(request) {
			const found: { readonly path: string; readonly kind: "file" | "folder" }[] = [];
			for (const path of request.paths) {
				const kind = await deps.kindOf(path);
				if (kind !== null) found.push({ path, kind });
			}
			const first = found[0];
			if (first === undefined) return;
			if (request.action === "reveal") {
				queue.push({ action: "reveal", path: first.path });
			} else {
				const attachments: ChatAttachment[] = found.map(({ path, kind }) => ({ kind, id: path, name: basename(path) }));
				queue.push({ action: "ask", attachments });
			}
			deps.onQueued();
		},
		take: () => queue.splice(0),
	};
}
