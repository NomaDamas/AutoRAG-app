import { MessageChannel, type MessagePort } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import {
	createWorkerClient,
	serveWorkerPort,
	type WorkerHandler,
	type WorkerPort,
} from "../src/shared/fs-worker-protocol";

/** One end of a real MessageChannel, adapted the way both Electron ports are. */
function adapt(port: MessagePort): WorkerPort {
	return {
		postMessage: (message) => port.postMessage(message),
		onMessage: (listener) => port.on("message", listener),
		close: () => port.close(),
	};
}

/** A served worker on a fresh channel; `client` is the end the client attaches. */
function worker(handlers: Readonly<Record<string, WorkerHandler>>): { readonly client: WorkerPort; readonly close: () => void } {
	const { port1, port2 } = new MessageChannel();
	const connection = serveWorkerPort(adapt(port1), handlers);
	return {
		client: adapt(port2),
		close: () => {
			connection.close();
			port1.close();
			port2.close();
		},
	};
}

/** A handler that never answers, and a promise for the moment it started. */
function hanging(): { readonly handler: WorkerHandler; readonly started: Promise<AbortSignal> } {
	const started = Promise.withResolvers<AbortSignal>();
	return {
		handler: (_args, signal) => {
			started.resolve(signal);
			return Promise.withResolvers<never>().promise;
		},
		started: started.promise,
	};
}

describe("fs worker protocol", () => {
	it("answers a request and carries an error's message and code across", async () => {
		const served = worker({
			echo: (args) => args,
			missing: () => {
				throw Object.assign(new Error("ENOENT: no such file, lstat '/gone'"), { code: "ENOENT" });
			},
		});
		const client = createWorkerClient();
		client.attach(served.client);

		await expect(client.call("echo", ["/a", 2])).resolves.toEqual(["/a", 2]);
		const error = await client.call("missing").catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({ message: "ENOENT: no such file, lstat '/gone'", code: "ENOENT" });
		await expect(client.call("nope")).rejects.toThrow("Unknown fs-worker op: nope");
		served.close();
	});

	it("queues calls made before the first port and sends them when it attaches", async () => {
		const served = worker({ ping: () => "pong" });
		const client = createWorkerClient();
		const early = client.call("ping");
		client.attach(served.client);
		await expect(early).resolves.toBe("pong");
		served.close();
	});

	it("cancelling a call rejects it at once and aborts the worker's signal for that op", async () => {
		const slow = hanging();
		const served = worker({ slow: slow.handler });
		const client = createWorkerClient();
		client.attach(served.client);
		const controller = new AbortController();
		const call = client.call("slow", [], { signal: controller.signal });
		const signal = await slow.started;
		const aborted = Promise.withResolvers<void>();
		signal.addEventListener("abort", () => aborted.resolve());
		controller.abort();
		await expect(call).rejects.toMatchObject({ name: "AbortError" });
		await aborted.promise;
		expect(signal.aborted).toBe(true);
		served.close();
	});

	it("re-sends an unanswered read on the new port after a restart, and fires onRestart", async () => {
		const slow = hanging();
		const first = worker({ listDir: slow.handler });
		const client = createWorkerClient();
		let restarts = 0;
		client.onRestart(() => {
			restarts += 1;
		});
		client.attach(first.client);
		const listing = client.call("listDir", ["/d"]);
		await slow.started;
		// The old worker dies with the listing in flight.
		first.close();
		const second = worker({ listDir: (args) => ({ path: args[0], entries: [] }) });
		client.attach(second.client);
		await expect(listing).resolves.toEqual({ path: "/d", entries: [] });
		expect(restarts).toBe(1);
		second.close();
	});

	it.each(["copy", "trash"])("rejects a %s that was in flight when the worker restarted instead of running it twice", async (op) => {
		const slow = hanging();
		const first = worker({ [op]: slow.handler });
		const client = createWorkerClient();
		client.attach(first.client);
		const write = client.call(op, [["/a"], "/b"]);
		await slow.started;
		first.close();
		let replayed = 0;
		const second = worker({
			[op]: () => {
				replayed += 1;
				return { ok: [], failed: [] };
			},
		});
		client.attach(second.client);
		await expect(write).rejects.toThrow("파일 서비스가 작업 도중 다시 시작되었습니다");
		expect(replayed).toBe(0);
		second.close();
	});

	it("ignores an answer that arrives on a port the client already replaced", async () => {
		const { port1, port2 } = new MessageChannel();
		const client = createWorkerClient();
		client.attach(adapt(port2));
		const call = client.call("stat", ["/f"]);
		const sent = Promise.withResolvers<void>();
		port1.once("message", () => sent.resolve());
		await sent.promise;
		const served = worker({ stat: () => "fresh" });
		client.attach(served.client);
		// The dead worker's late reply for request 1 must not settle the call.
		port1.postMessage({ id: 1, ok: true, value: "stale" });
		await expect(call).resolves.toBe("fresh");
		port1.close();
		served.close();
	});

	it("delivers pushes to their listeners until unsubscribed", async () => {
		const { port1, port2 } = new MessageChannel();
		const connection = serveWorkerPort(adapt(port1), { ping: () => "pong" });
		const client = createWorkerClient();
		client.attach(adapt(port2));
		const seen: unknown[] = [];
		const first = Promise.withResolvers<void>();
		const off = client.onPush("live", (payload) => {
			seen.push(payload);
			first.resolve();
		});
		connection.push("live", { seq: 1 });
		await first.promise;
		off();
		connection.push("live", { seq: 2 });
		// A round trip on the same port: the second push is delivered before the answer.
		await client.call("ping");
		expect(seen).toEqual([{ seq: 1 }]);
		port1.close();
		port2.close();
	});
});
