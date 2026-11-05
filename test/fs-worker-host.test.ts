import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFsWorkerHost } from "../src/main/fs-worker-host";

/** A MessagePortMain stand-in: records what was posted on it and whether it was closed. */
class FakePort extends EventEmitter {
	closed = false;
	postMessage(): void {}
	start(): void {}
	close(): void {
		this.closed = true;
	}
}

class FakeChild extends EventEmitter {
	readonly pid: number;
	readonly posted: { message: unknown; ports: FakePort[] }[] = [];
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	constructor(pid: number) {
		super();
		this.pid = pid;
	}
	postMessage(message: unknown, ports: FakePort[] = []): void {
		this.posted.push({ message, ports });
	}
	kill(): void {}
	rendererPorts(): FakePort[] {
		return this.posted.filter(({ message }) => typeof message === "object" && message !== null && "kind" in message && message.kind === "renderer").flatMap((entry) => entry.ports);
	}
}

const children: FakeChild[] = [];

vi.mock("electron", () => ({
	MessageChannelMain: class {
		readonly port1 = new FakePort();
		readonly port2 = new FakePort();
	},
	utilityProcess: {
		fork: () => {
			const child = new FakeChild(1000 + children.length);
			children.push(child);
			return child;
		},
	},
}));

/** A WebContents stand-in whose `postMessage` throws once its render frame is gone, as Electron's does. */
function fakeContents() {
	const contents = Object.assign(new EventEmitter(), {
		frameGone: false,
		received: [] as FakePort[],
		isDestroyed: () => false,
		postMessage(_channel: string, _message: unknown, ports: FakePort[]) {
			if (contents.frameGone) throw new Error("Render frame was disposed before WebFrameMain could be accessed");
			contents.received.push(...ports);
		},
	});
	return contents;
}

function host() {
	return createFsWorkerHost({
		config: { userDataDir: "/tmp/fs-worker-host-test" },
		shell: {} as never,
		clipboard: {} as never,
		icons: {} as never,
		entry: "/nonexistent/fs-worker.js",
	});
}

describe("fs worker host restart", () => {
	beforeEach(() => {
		children.length = 0;
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("restarts past a page whose render frame is gone and still re-attaches every other page (ELECTRON-K)", () => {
		const workerHost = host();
		const gone = fakeContents();
		const live = fakeContents();
		workerHost.connect(gone as never);
		workerHost.connect(live as never);
		gone.frameGone = true;

		children[0]!.emit("exit", 1);
		expect(() => vi.runOnlyPendingTimers()).not.toThrow();

		expect(children).toHaveLength(2);
		expect(live.received).toHaveLength(2);
		// The worker holds only the end of a channel some page actually received: none left dangling.
		expect(children[1]!.rendererPorts()).toHaveLength(1);
		expect(workerHost.status()).toEqual({ pid: children[1]!.pid, restarts: 1 });

		// The next crash restarts again: the first restart finished wiring its exit listener.
		children[1]!.emit("exit", 1);
		vi.runOnlyPendingTimers();
		expect(children).toHaveLength(3);
		expect(live.received).toHaveLength(3);
	});

	it("hands the page a port again once its next document asks", () => {
		const workerHost = host();
		const page = fakeContents();
		workerHost.connect(page as never);
		page.frameGone = true;
		children[0]!.emit("exit", 1);
		vi.runOnlyPendingTimers();
		expect(page.received).toHaveLength(1);

		// The reloaded document's preload asks for its port.
		page.frameGone = false;
		workerHost.connect(page as never);
		expect(page.received).toHaveLength(2);
		expect(children[1]!.rendererPorts()).toHaveLength(1);
	});
});
