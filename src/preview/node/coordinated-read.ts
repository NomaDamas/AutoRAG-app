import { execFile } from "node:child_process";

/** No compiler or app automation permission needed: Foundation coordinates with the file provider. */
const COORDINATED_READ = `
ObjC.import("Foundation");
function run(argv) {
	const coordinator = $.NSFileCoordinator.alloc.initWithFilePresenter($());
	const coordinationError = Ref();
	let result = null;
	let failure = null;
	coordinator.coordinateReadingItemAtURLOptionsErrorByAccessor(
		$.NSURL.fileURLWithPath(argv[0]), 0, coordinationError, function(url) {
			const readError = Ref();
			const handle = $.NSFileHandle.fileHandleForReadingFromURLError(url, readError);
			if (handle.isNil()) {
				failure = ObjC.unwrap(readError[0].localizedDescription);
				return;
			}
			try {
				const data = $.NSMutableData.data;
				let remaining = Number(argv[1]);
				while (remaining > 0) {
					const chunk = handle.readDataOfLength(remaining);
					if (chunk.length === 0) break;
					data.appendData(chunk);
					remaining -= chunk.length;
				}
				result = ObjC.unwrap(data.base64EncodedStringWithOptions(0));
			} catch (error) {
				failure = String(error);
			} finally {
				handle.closeFile;
			}
		}
	);
	if (failure !== null) throw new Error(failure);
	if (result === null) throw new Error(ObjC.unwrap(coordinationError[0].localizedDescription));
	return result;
}`;

/** Read inside the coordination accessor, not afterwards: the provider's grant ends with the accessor. */
export function readCoordinatedHead(path: string, length: number): Promise<Uint8Array> {
	const { promise, resolve, reject } = Promise.withResolvers<Uint8Array>();
	execFile(
		"/usr/bin/osascript",
		["-l", "JavaScript", "-e", COORDINATED_READ, path, String(length)],
		{ timeout: 60_000, maxBuffer: Math.ceil(length / 3) * 4 + 4096 },
		(error, stdout) => {
			if (error !== null) reject(error);
			else resolve(Buffer.from(stdout.trim(), "base64"));
		},
	);
	return promise;
}
