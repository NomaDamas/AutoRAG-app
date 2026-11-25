import { execFile, spawn } from "node:child_process";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/** Darwin EDEADLK is 11; libuv may expose it only as an unmapped negative errno. */
export function needsFileCoordination(error: unknown): boolean {
	return process.platform === "darwin" && typeof error === "object" && error !== null &&
		(("code" in error && error.code === "EDEADLK") || ("errno" in error && error.errno === -11));
}

const COORDINATED_COPY = `
ObjC.import("Foundation");
function run(argv) {
	const coordinator = $.NSFileCoordinator.alloc.initWithFilePresenter($());
	const error = Ref();
	let copied = false;
	let failure = null;
	coordinator.coordinateReadingItemAtURLOptionsErrorByAccessor(
		$.NSURL.fileURLWithPath(argv[0]), 0, error, function(url) {
			const copyError = Ref();
			copied = $.NSFileManager.defaultManager.copyItemAtURLToURLError(url.URLByResolvingSymlinksInPath, $.NSURL.fileURLWithPath(argv[1]), copyError);
			if (!copied) failure = ObjC.unwrap(copyError[0].localizedDescription);
		}
	);
	if (failure !== null) throw new Error(failure);
	if (!copied) throw new Error(ObjC.unwrap(error[0].localizedDescription));
}`;

/** A disk snapshot, not a whole-file JS/base64 buffer. Released when its consumer finishes. */
export async function coordinatedSnapshot(path: string): Promise<{ readonly path: string; dispose(): Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "dazzi-preview-provider-"));
	const snapshot = join(dir, basename(path));
	const dispose = (): Promise<void> => rm(dir, { recursive: true, force: true });
	try {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", COORDINATED_COPY, path, snapshot], { timeout: 60_000 }, (error) => {
			if (error !== null) reject(error);
			else resolve();
		});
		await promise;
		return { path: snapshot, dispose };
	} catch (error) {
		await dispose();
		throw error;
	}
}

/** Native tools hide errno; probe only after they failed, never on a successful/local fast path. */
async function providerRefusesRead(path: string): Promise<boolean> {
	if (process.platform !== "darwin") return false;
	try {
		const handle = await open(path, "r");
		try {
			await handle.read(new Uint8Array(1), 0, 1, 0);
		} finally {
			await handle.close();
		}
		return false;
	} catch (error) {
		return needsFileCoordination(error);
	}
}

/** Original operation first. Retry only a verified provider deadlock, with no persistent copies or altered local reads. */
export async function withReadableFile<T>(path: string, consume: (localPath: string) => Promise<T>, nativeError = false): Promise<T> {
	try {
		return await consume(path);
	} catch (error) {
		if (!needsFileCoordination(error) && !(nativeError && await providerRefusesRead(path))) throw error;
		const snapshot = await coordinatedSnapshot(path);
		try {
			return await consume(snapshot.path);
		} finally {
			await snapshot.dispose();
		}
	}
}

const COORDINATED_RANGE = `
ObjC.import("Foundation");
function run(argv) {
	const coordinator = $.NSFileCoordinator.alloc.initWithFilePresenter($());
	const error = Ref();
	let accessed = false;
	let failure = null;
	coordinator.coordinateReadingItemAtURLOptionsErrorByAccessor(
		$.NSURL.fileURLWithPath(argv[0]), 0, error, function(url) {
			accessed = true;
			const readError = Ref();
			const input = $.NSFileHandle.fileHandleForReadingFromURLError(url, readError);
			if (input.isNil()) { failure = ObjC.unwrap(readError[0].localizedDescription); return; }
			try {
				input.seekToFileOffset(Number(argv[1]));
				let remaining = Number(argv[2]) - Number(argv[1]) + 1;
				const output = $.NSFileHandle.fileHandleWithStandardOutput;
				while (remaining > 0) {
					const chunk = input.readDataOfLength(Math.min(remaining, 1024 * 1024));
					if (chunk.length === 0) throw new Error("Unexpected end of file during coordinated read");
					output.writeData(chunk);
					remaining -= chunk.length;
				}
			} catch (caught) { failure = String(caught); }
			finally { input.closeFile; }
		}
	);
	if (failure !== null) throw new Error(failure);
	if (!accessed) throw new Error(ObjC.unwrap(error[0].localizedDescription));
}`;

/** Stream just the requested range inside the coordination grant; seeking never copies the whole media file. */
export async function* coordinatedRange(path: string, start: number, end: number): AsyncGenerator<Buffer> {
	const child = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", COORDINATED_RANGE, path, String(start), String(end)], { stdio: ["ignore", "pipe", "pipe"] });
	const { promise, resolve } = Promise.withResolvers<Error | null>();
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
	child.once("error", (error) => resolve(error));
	child.once("close", (code) => resolve(code === 0 ? null : new Error(stderr.trim() || `Coordinated read exited ${code}`)));
	const timer = setTimeout(() => child.kill(), 60_000);
	try {
		for await (const chunk of child.stdout) {
			clearTimeout(timer);
			yield chunk as Buffer;
		}
		const error = await promise;
		if (error !== null) throw error;
	} finally {
		clearTimeout(timer);
		if (child.exitCode === null) child.kill();
	}
}
