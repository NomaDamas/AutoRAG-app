import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAppLanguage } from "../src/shared/i18n/core";
import type { VoiceClip } from "../src/shared/voice-contract";
import { createVoiceService, systemMicrophoneAccess, type VoiceService } from "../src/main/voice-service";

/** A stand-in for the hosted `POST /v1/audio/transcriptions`: it records what it was sent and answers as scripted. */
interface Fake {
	readonly url: string;
	readonly requests: { method: string; path: string; auth: string | undefined; contentType: string | undefined; body: Buffer }[];
	reply: { status: number; body: unknown };
	close(): Promise<void>;
}

async function readAll(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks);
}

async function startFake(): Promise<Fake> {
	const requests: Fake["requests"] = [];
	const fake: Fake = {
		url: "",
		requests,
		reply: { status: 200, body: { text: "지난달 매출 보고서를 찾아 줘", duration: 4 } },
		close: () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			server.close(() => resolve());
			return promise;
		},
	};
	const server: Server = createServer((request, response) => {
		void readAll(request).then((body) => {
			requests.push({ method: request.method ?? "", path: request.url ?? "", auth: request.headers.authorization, contentType: request.headers["content-type"], body });
			response.writeHead(fake.reply.status, { "Content-Type": "application/json" });
			response.end(JSON.stringify(fake.reply.body));
		});
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	return Object.assign(fake, { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
}

const CLIP: VoiceClip = { audio: new TextEncoder().encode("OPUSBYTES").buffer as ArrayBuffer, mimeType: "audio/webm;codecs=opus", language: "ko" };

let fake: Fake;
let key: string | null;
let service: VoiceService;

const GRANTED = { status: async () => "granted", ask: async () => true, openSettings: async () => {} };
beforeEach(async () => {
	setAppLanguage("en");
	fake = await startFake();
	key = "dz_test_key";
	service = createVoiceService({ env: { AUTORAG_BASE_URL: `${fake.url}/` }, readKey: async () => key, microphone: GRANTED });
});

afterEach(async () => {
	await fake.close();
});

describe("transcribe", () => {
	it("posts the clip as multipart to /v1/audio/transcriptions with the account key and returns the text", async () => {
		const result = await service.transcribe(CLIP);

		expect(result).toEqual({ text: "지난달 매출 보고서를 찾아 줘", seconds: 4 });
		expect(fake.requests).toHaveLength(1);
		const [request] = fake.requests;
		expect(request?.method).toBe("POST");
		expect(request?.path).toBe("/v1/audio/transcriptions");
		expect(request?.auth).toBe("Bearer dz_test_key");
		expect(request?.contentType).toMatch(/^multipart\/form-data; boundary=/u);
		const body = request?.body.toString("latin1") ?? "";
		expect(body).toContain('name="file"; filename="voice.webm"');
		expect(body).toContain("Content-Type: audio/webm");
		expect(body).toContain("OPUSBYTES");
		expect(body).toContain('name="language"');
		expect(body).toContain("ko-KR");
		expect(body).toContain('name="model"');
		expect(body).toContain("google/stt-v2-standard");
	});

	it("asks for the recognition language of the clip", async () => {
		await service.transcribe({ ...CLIP, language: "ja" });
		expect(fake.requests[0]?.body.toString("latin1")).toContain("ja-JP");
	});

	it("returns an empty transcript when the service heard no speech", async () => {
		fake.reply = { status: 200, body: { text: "", duration: 3 } };
		await expect(service.transcribe(CLIP)).resolves.toEqual({ text: "", seconds: 3 });
	});

	it("refuses before any request when nobody is signed in", async () => {
		key = null;
		await expect(service.transcribe(CLIP)).rejects.toThrow("Sign in to your Dazzi account first.");
		expect(fake.requests).toHaveLength(0);
	});

	it("shows the server's own message when it refuses the clip", async () => {
		fake.reply = { status: 429, body: { error: { message: "Weekly usage quota exceeded" } } };
		await expect(service.transcribe(CLIP)).rejects.toThrow("Weekly usage quota exceeded");
	});

	it("names the status when the server's refusal has no message", async () => {
		fake.reply = { status: 502, body: null };
		await expect(service.transcribe(CLIP)).rejects.toThrow("The Dazzi service answered HTTP 502.");
	});

	it("says the service is unreachable instead of leaking the network error", async () => {
		const offline = createVoiceService({ env: { AUTORAG_BASE_URL: "http://127.0.0.1:1" }, readKey: async () => key, microphone: GRANTED });
		await expect(offline.transcribe(CLIP)).rejects.toThrow("Cannot reach the Dazzi service. Check your connection and try again.");
	});

	it("rejects a malformed answer instead of returning undefined text", async () => {
		fake.reply = { status: 200, body: { nope: true } };
		await expect(service.transcribe(CLIP)).rejects.toThrow("The Dazzi service returned a transcript this app cannot read.");
	});
});

describe("prepare", () => {
	const make = (signedIn: boolean, status: string, ask: () => Promise<boolean>) =>
		createVoiceService({ env: {}, readKey: async () => (signedIn ? "dz_test_key" : null), microphone: { status: async () => status, ask, openSettings: async () => {} } });

	it("is ready without asking the system when the account is signed in and the microphone already granted", async () => {
		let asked = 0;
		await expect(make(true, "granted", async () => { asked += 1; return true; }).prepare()).resolves.toBe("ready");
		expect(asked).toBe(0);
	});

	it("tells a signed-out person before anything is recorded, and never raises the system's microphone prompt for it", async () => {
		let asked = 0;
		let consulted = 0;
		const service = createVoiceService({
			env: {},
			readKey: async () => null,
			microphone: { status: async () => { consulted += 1; return "not-determined"; }, ask: async () => { asked += 1; return true; }, openSettings: async () => {} },
		});
		await expect(service.prepare()).resolves.toBe("signed-out");
		expect(asked).toBe(0);
		expect(consulted).toBe(0);
	});

	it("asks the system when the choice has not been made, and reports the answer", async () => {
		let asked = 0;
		await expect(make(true, "not-determined", async () => { asked += 1; return true; }).prepare()).resolves.toBe("ready");
		await expect(make(true, "not-determined", async () => { asked += 1; return false; }).prepare()).resolves.toBe("microphone-denied");
		expect(asked).toBe(2);
	});

	it("never asks again after the person denied it or the system restricts it", async () => {
		let asked = 0;
		const ask = async () => { asked += 1; return true; };
		await expect(make(true, "denied", ask).prepare()).resolves.toBe("microphone-denied");
		await expect(make(true, "restricted", ask).prepare()).resolves.toBe("microphone-denied");
		expect(asked).toBe(0);
	});
});

describe("systemMicrophoneAccess", () => {
	const calls: string[] = [];
	const prefs = {
		getMediaAccessStatus: (type: string) => { calls.push(`status:${type}`); return "denied"; },
		askForMediaAccess: async (type: string) => { calls.push(`ask:${type}`); return true; },
	};
	const opened: string[] = [];
	const openExternal = async (url: string) => { opened.push(url); };

	beforeEach(() => {
		calls.length = 0;
		opened.length = 0;
	});

	it("macOS reports the system's status, raises its prompt, and opens Privacy & Security › Microphone", async () => {
		const access = systemMicrophoneAccess({ platform: "darwin", preferences: prefs, openExternal });
		await expect(access.status()).resolves.toBe("denied");
		await expect(access.ask()).resolves.toBe(true);
		await access.openSettings();
		expect(calls).toEqual(["status:microphone", "ask:microphone"]);
		expect(opened).toEqual(["x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"]);
	});

	it("Windows reports Electron's status, which follows all three privacy switches (measured on Windows 11), and opens Settings › Privacy › Microphone", async () => {
		const access = systemMicrophoneAccess({ platform: "win32", preferences: prefs, openExternal });
		await expect(access.status()).resolves.toBe("denied");
		await access.openSettings();
		expect(opened).toEqual(["ms-settings:privacy-microphone"]);
	});

	it("Windows has no prompt of the app's own: a switch that is off is turned on in Settings", async () => {
		const access = systemMicrophoneAccess({ platform: "win32", preferences: prefs, openExternal });
		await expect(access.ask()).resolves.toBe(false);
		expect(calls).toEqual([]);
	});

	it("Linux has neither call (Electron does not provide them there): the browser's own permission decides", async () => {
		const access = systemMicrophoneAccess({ platform: "linux", preferences: prefs, openExternal });
		await expect(access.status()).resolves.toBe("granted");
		await expect(access.ask()).resolves.toBe(true);
		await access.openSettings();
		expect(calls).toEqual([]);
		expect(opened).toEqual([]);
	});
});

describe("openMicrophoneSettings", () => {
	it("hands over to the platform's settings page", async () => {
		let opened = 0;
		const service = createVoiceService({ env: {}, readKey: async () => "dz", microphone: { status: async () => "granted", ask: async () => true, openSettings: async () => { opened += 1; } } });
		await service.openMicrophoneSettings();
		expect(opened).toBe(1);
	});
});
