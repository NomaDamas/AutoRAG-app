// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppLanguage } from "../src/shared/i18n";
import type { RemoteAccessStatus, RemotePairedDevice, RemotePairingCode } from "../src/shared/remote-contract";
import { DEFAULT_SETTINGS, type AppSettings, type AutoRagConfigSnapshot } from "../src/shared/settings-contract";
import { GeneralPage } from "../src/renderer/src/components/settings/GeneralPage";

const mockRemote = vi.hoisted(() => {
	const listeners = new Set<(status: RemoteAccessStatus) => void>();
	const remote = {
		status: vi.fn<() => Promise<RemoteAccessStatus>>(),
		start: vi.fn<() => Promise<RemoteAccessStatus>>(),
		stop: vi.fn<() => Promise<RemoteAccessStatus>>(),
		startPairing: vi.fn<() => Promise<RemotePairingCode>>(),
		devices: vi.fn<() => Promise<readonly RemotePairedDevice[]>>(),
		renameDevice: vi.fn<(id: string, label: string) => Promise<RemotePairedDevice | null>>(),
		revokeDevice: vi.fn<(id: string) => Promise<boolean>>(),
		revokeAllDevices: vi.fn<() => Promise<number>>(),
		refreshNetwork: vi.fn<() => Promise<RemoteAccessStatus>>(),
		startTunnel: vi.fn<() => Promise<RemoteAccessStatus>>(),
		stopTunnel: vi.fn<() => Promise<RemoteAccessStatus>>(),
		onChange: (fn: (status: RemoteAccessStatus) => void) => {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		},
	};
	const settings = {
		set: vi.fn<(patch: Partial<AppSettings>) => Promise<AppSettings>>(),
	};
	Reflect.set(globalThis, "autorag", {
		platform: "darwin",
		remote,
		settings,
		appUpdate: { get: () => new Promise(() => undefined), onChange: () => () => undefined },
	});
	return {
		remote,
		settings,
		emit: (status: RemoteAccessStatus) => {
			for (const fn of listeners) fn(status);
		},
		clear: () => listeners.clear(),
	};
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const SNAPSHOT: AutoRagConfigSnapshot = {
	configPath: "/tmp/config.json",
	configExists: true,
	error: null,
	config: { datasources: {}, searchPaths: ["/docs"] },
};

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
	await setAppLanguage("en");
	mockRemote.clear();
	vi.clearAllMocks();
	container = document.createElement("div");
	container.className = "settings-view";
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container.remove();
});

describe("RemoteAccessSection in GeneralPage", () => {
	it("shows stopped state with zero extra clutter when remoteAccess is off", async () => {
		const stoppedStatus: RemoteAccessStatus = {
			serving: false,
			origin: null,
			port: 47833,
			sessions: 0,
			devices: [],
		};
		mockRemote.remote.status.mockResolvedValue(stoppedStatus);

		await act(async () => {
			root.render(
				<GeneralPage
					appSettings={{ ...DEFAULT_SETTINGS, language: "en", remoteAccess: false }}
					onAppSettingsChanged={() => undefined}
					onSettingsError={() => undefined}
					snapshot={SNAPSHOT}
					onSaved={() => undefined}
				/>,
			);
		});

		const addressInput = container.querySelector('input[aria-label="Browser Address"]') as HTMLInputElement;
		expect(addressInput.value).toBe("Stopped");
		expect(container.querySelector(".settings-remote-hub")).toBeNull();
	});

	it("renders Pairing Code + QR, Tailscale command, Quick Tunnel start, and Paired Devices actions when serving", async () => {
		const expiresAt = new Date(Date.now() + 9 * 60_000).toISOString();
		const activeStatus: RemoteAccessStatus = {
			serving: true,
			origin: "http://localhost:47833/?token=sec-tok",
			baseOrigin: "http://localhost:47833",
			port: 47833,
			sessions: 1,
			lanOrigins: ["http://192.168.0.42:47833"],
			tailscale: {
				state: "running",
				dnsName: "mac.tailnet.ts.net",
				tailnetIp: "100.88.1.2",
				owner: "user@example.com",
				servingUrl: null,
				serveCommand: "tailscale serve --bg --https=443 http://127.0.0.1:47833",
				serveUrl: "https://mac.tailnet.ts.net",
			},
			tunnel: {
				available: true,
				state: "off",
				url: null,
				error: null,
			},
			pairing: null,
			devices: [
				{
					id: "0123456789abcdef",
					label: "iPhone · Safari",
					createdAt: new Date(Date.now() - 60_000).toISOString(),
					lastSeenAt: new Date().toISOString(),
					current: true,
				},
			],
		};
		mockRemote.remote.status.mockResolvedValue(activeStatus);
		mockRemote.remote.startPairing.mockResolvedValue({ code: "482910", expiresAt });
		mockRemote.remote.startTunnel.mockResolvedValue({
			...activeStatus,
			tunnel: { available: true, state: "online", url: "https://sunny-fox.trycloudflare.com", error: null },
		});
		mockRemote.remote.renameDevice.mockResolvedValue({
			id: "0123456789abcdef",
			label: "Jeffrey iPhone",
			createdAt: activeStatus.devices![0]!.createdAt,
			lastSeenAt: activeStatus.devices![0]!.lastSeenAt,
		});
		mockRemote.remote.revokeDevice.mockResolvedValue(true);

		await act(async () => {
			root.render(
				<GeneralPage
					appSettings={{ ...DEFAULT_SETTINGS, language: "en", remoteAccess: true }}
					onAppSettingsChanged={() => undefined}
					onSettingsError={() => undefined}
					snapshot={SNAPSHOT}
					onSaved={() => undefined}
				/>,
			);
		});

		// Pairing Code tab: click "Get Pairing Code" -> displays spaced "482 910" and QR SVG
		const startPairBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Get Pairing Code");
		expect(startPairBtn).toBeTruthy();
		await act(async () => {
			startPairBtn?.click();
		});
		expect(mockRemote.remote.startPairing).toHaveBeenCalledTimes(1);
		expect(container.textContent).toContain("482 910");
		expect(container.querySelector("svg.settings-remote-qr")).not.toBeNull();

		// Switch to Tailscale tab -> displays tailscale serve command and direct IP
		const tsTab = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Tailscale");
		await act(async () => {
			tsTab?.click();
		});
		expect(container.textContent).toContain("tailscale serve --bg --https=443 http://127.0.0.1:47833");
		expect(container.textContent).toContain("http://100.88.1.2:47833");

		// Switch to Quick Tunnel tab -> start tunnel -> shows trycloudflare URL
		const tunnelTab = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Quick Tunnel");
		await act(async () => {
			tunnelTab?.click();
		});
		const startTunnelBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Start Tunnel");
		await act(async () => {
			startTunnelBtn?.click();
		});
		expect(mockRemote.remote.startTunnel).toHaveBeenCalledTimes(1);
		expect(container.textContent).toContain("https://sunny-fox.trycloudflare.com");

		// Paired Devices list shows "iPhone · Safari" and "this device" badge, supports two-step revoke
		expect(container.textContent).toContain("iPhone · Safari");
		expect(container.textContent).toContain("this device");
		const revokeBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Revoke");
		await act(async () => {
			revokeBtn?.click();
		});
		const confirmRevokeBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Confirm Revoke");
		expect(confirmRevokeBtn).toBeTruthy();
		await act(async () => {
			confirmRevokeBtn?.click();
		});
		expect(mockRemote.remote.revokeDevice).toHaveBeenCalledWith("0123456789abcdef");
	});
});
