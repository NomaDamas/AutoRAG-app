import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { net } from "electron";
import { pathFromPreviewUrl } from "../shared/contract";

function isEnoent(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function handlePreviewRequest(request: Request): Promise<Response> {
	const filePath = pathFromPreviewUrl(request.url);
	if (filePath === null || !isAbsolute(filePath)) return new Response("bad path", { status: 400 });
	try {
		const followed = await stat(filePath);
		if (!followed.isFile()) return new Response("not a file", { status: 404 });
	} catch (error) {
		if (isEnoent(error)) return new Response("missing", { status: 404 });
		throw error;
	}
	return net.fetch(pathToFileURL(filePath).href, { headers: request.headers });
}
