// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppLanguage } from "../src/shared/i18n";
import type { RemoteAccessStatus, RemotePairedDevice, RemotePairingCode } from "../src/shared/remote-contract";
import { DEFAULT_SETTINGS, type AppSettings } from "../src/shared/settings-contract";
import { RemoteAccessPage } from "../src/renderer/src/components/settings/RemoteAccessPage";

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
		loginTunnel: vi.fn<() => Promise<RemoteAccessStatus>>(),
		startTailscaleServe: vi.fn<() => Promise<RemoteAccessStatus>>(),
		stopTailscaleServe: vi.fn<() => Promise<RemoteAccessStatus>>(),
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

const QUICK_OFF = { available: true, mode: "quick", hostname: null, loggedIn: false, state: "off", url: null, error: null, errorCode: null } as const;

function activeStatus(overrides: Partial<RemoteAccessStatus> = {}): RemoteAccessStatus {
	return {
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
			servingPort: null,
			serveCommand: "tailscale serve --bg --https=443 http://127.0.0.1:47833",
			serveUrl: "https://mac.tailnet.ts.net",
			servePort: 443,
		},
		tunnel: QUICK_OFF,
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
		...overrides,
	};
}

async function render(settings: Partial<AppSettings>): Promise<void> {
	await act(async () => {
		root.render(
			<RemoteAccessPage
				appSettings={{ ...DEFAULT_SETTINGS, language: "en", ...settings }}
				onAppSettingsChanged={() => undefined}
				onSettingsError={() => undefined}
			/>,
		);
	});
}

function button(text: string): HTMLButtonElement | undefined {
	return Array.from(container.querySelectorAll("button")).find((b) => b.textContent === text);
}

async function click(element: HTMLElement | null | undefined): Promise<void> {
	expect(element).toBeTruthy();
	await act(async () => {
		element?.click();
	});
}

function routeAddress(): string | null {
	return container.querySelector('[data-testid="remote-route-address"]')?.textContent ?? null;
}

describe("Settings → Remote Access page", () => {
	it("shows only the Enable switch while remote access is off", async () => {
		mockRemote.remote.status.mockResolvedValue({ serving: false, origin: null, port: 47833, sessions: 0, devices: [] });
		await render({ remoteAccess: false });

		expect(container.querySelector('[role="switch"][aria-label="Enable Remote Access"]')).not.toBeNull();
		expect(container.querySelector('input[aria-label="Browser Address"]')).toBeNull();
		expect(container.querySelector('input[aria-label="Port"]')).toBeNull();
		expect(container.textContent).not.toContain("Connect a Device");
		expect(container.textContent).not.toContain("Paired Devices");
	});

	it("pairs through the chosen route: the QR link follows the route address, one code for every route", async () => {
		const expiresAt = new Date(Date.now() + 9 * 60_000).toISOString();
		const status = activeStatus();
		mockRemote.remote.status.mockResolvedValue(status);
		mockRemote.remote.startPairing.mockResolvedValue({ code: "482910", expiresAt });
		mockRemote.remote.startTunnel.mockResolvedValue({
			...status,
			tunnel: { ...QUICK_OFF, state: "online", url: "https://sunny-fox.trycloudflare.com" },
		});
		await render({ remoteAccess: true });

		// Same Wi-Fi is the default when only a LAN address works.
		expect(routeAddress()).toBe("http://192.168.0.42:47833");
		await click(button("Get Pairing Code"));
		expect(mockRemote.remote.startPairing).toHaveBeenCalledTimes(1);
		expect(container.querySelector('[data-testid="remote-pairing-code"]')?.textContent).toBe("482 910");
		expect(container.querySelector("svg.settings-remote-qr")).not.toBeNull();

		// Tailscale: the tailnet IP as the address until it is published; the command stays available behind a disclosure.
		await click(button("Tailscale"));
		expect(button("Publish over HTTPS in Tailnet")).toBeDefined();
		expect(container.querySelector("details code")?.textContent).toBe("tailscale serve --bg --https=443 http://127.0.0.1:47833");
		expect(routeAddress()).toBe("http://100.88.1.2:47833");
		expect(container.querySelector('[data-testid="remote-pairing-code"]')?.textContent).toBe("482 910");

		// Internet: no address until the tunnel is online, then the trycloudflare address.
		await click(button("Internet"));
		expect(routeAddress()).toBeNull();
		expect(container.textContent).toContain("The QR code appears once a route above has an address.");
		await click(button("Start Tunnel"));
		expect(mockRemote.remote.startTunnel).toHaveBeenCalledTimes(1);
		expect(routeAddress()).toBe("https://sunny-fox.trycloudflare.com");
		expect(container.querySelector("svg.settings-remote-qr")).not.toBeNull();
		expect(mockRemote.remote.startPairing).toHaveBeenCalledTimes(1);
	});

	it("keeps the token address and the port behind Details", async () => {
		mockRemote.remote.status.mockResolvedValue(activeStatus());
		await render({ remoteAccess: true });

		const details = container.querySelector("details.settings-remote-details") as HTMLDetailsElement;
		expect(details.open).toBe(false);
		const address = details.querySelector('input[aria-label="Browser Address"]') as HTMLInputElement;
		expect(address.value).toBe("http://localhost:47833/?token=sec-tok");
		expect(details.querySelector('input[aria-label="Port"]')).not.toBeNull();
	});

	it("own domain: rejects a non-hostname, saves a normalized one, and asks for a Cloudflare sign-in before starting", async () => {
		const custom = activeStatus({
			tunnel: { ...QUICK_OFF, mode: "custom", hostname: "dazzi.example.com", errorCode: "login_required", state: "error" },
		});
		mockRemote.remote.status.mockResolvedValue(activeStatus());
		mockRemote.settings.set.mockImplementation(async (patch) => ({ ...DEFAULT_SETTINGS, language: "en", remoteAccess: true, ...patch }));
		mockRemote.remote.loginTunnel.mockResolvedValue({ ...custom, tunnel: { ...custom.tunnel!, loggedIn: true, errorCode: null, state: "off" } });
		await render({ remoteAccess: true });
		await click(button("Internet"));

		const domain = container.querySelector('input[aria-label="Domain"]') as HTMLInputElement;
		const type = async (value: string): Promise<void> => {
			await act(async () => {
				const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
				setter.call(domain, value);
				domain.dispatchEvent(new Event("input", { bubbles: true }));
			});
			await act(async () => {
				domain.focus();
				domain.blur();
			});
		};

		await type("https://dazzi.example.com/path");
		expect(container.textContent).toContain("Not a domain name: https://dazzi.example.com/path");
		expect(mockRemote.settings.set).not.toHaveBeenCalled();

		await type("  Dazzi.Example.com. ");
		expect(mockRemote.settings.set).toHaveBeenCalledWith({ remoteTunnelHostname: "dazzi.example.com" });

		await act(async () => mockRemote.emit(custom));
		expect(container.textContent).toContain("Own domain: dazzi.example.com");
		expect(container.textContent).toContain("Sign in to Cloudflare before using your own domain.");
		expect(button("Start Tunnel")?.disabled).toBe(true);
		await click(button("Sign in to Cloudflare"));
		expect(mockRemote.remote.loginTunnel).toHaveBeenCalledTimes(1);
		expect(button("Start Tunnel")?.disabled).toBe(false);
	});

	it("revokes a paired device only after a second click", async () => {
		mockRemote.remote.status.mockResolvedValue(activeStatus());
		mockRemote.remote.revokeDevice.mockResolvedValue(true);
		await render({ remoteAccess: true });

		expect(container.textContent).toContain("iPhone · Safari");
		expect(container.textContent).toContain("this device");
		await click(button("Revoke"));
		expect(mockRemote.remote.revokeDevice).not.toHaveBeenCalled();
		await click(button("Confirm Revoke"));
		expect(mockRemote.remote.revokeDevice).toHaveBeenCalledWith("0123456789abcdef");
	});

	it("says which port is taken instead of waiting forever, and starts on a free port with one click", async () => {
		const blocked: RemoteAccessStatus = {
			serving: false,
			origin: null,
			port: 47833,
			sessions: 0,
			devices: [],
			serverError: { code: "port_in_use", port: 47833, suggestedPort: 51234 },
		};
		mockRemote.remote.status.mockResolvedValue(blocked);
		mockRemote.settings.set.mockImplementation(async (patch) => ({ ...DEFAULT_SETTINGS, language: "en", remoteAccess: true, ...patch }));
		mockRemote.remote.start.mockResolvedValue(activeStatus({ port: 51234, origin: "http://localhost:51234/?token=t", lanOrigins: ["http://192.168.0.42:51234"] }));
		await render({ remoteAccess: true });

		expect(container.querySelector('[role="alert"]')?.textContent).toContain("another program is using port 47833");
		expect(container.textContent).not.toContain("Starting the remote access server");
		await click(button("Start on port 51234"));

		expect(mockRemote.settings.set).toHaveBeenCalledWith({ remotePort: 51234 });
		expect(mockRemote.remote.start).toHaveBeenCalledTimes(1);
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(routeAddress()).toBe("http://192.168.0.42:51234");
	});

	it("publishes Dazzi in the tailnet with one click, shows its HTTPS address, and can stop it", async () => {
		const status = activeStatus();
		const published: RemoteAccessStatus = {
			...status,
			tailscale: { ...status.tailscale!, servingUrl: "https://mac.tailnet.ts.net", servingPort: 443, serveCommand: null, servePort: null },
		};
		mockRemote.remote.status.mockResolvedValue(status);
		mockRemote.remote.startTailscaleServe.mockResolvedValue(published);
		mockRemote.remote.stopTailscaleServe.mockResolvedValue(status);
		await render({ remoteAccess: true });
		await click(button("Tailscale"));
		expect(routeAddress()).toBe("http://100.88.1.2:47833");

		await click(button("Publish over HTTPS in Tailnet"));
		expect(mockRemote.remote.startTailscaleServe).toHaveBeenCalledTimes(1);
		expect(container.textContent).toContain("Published over HTTPS in your tailnet");
		expect(routeAddress()).toBe("https://mac.tailnet.ts.net");

		await click(button("Stop Publishing"));
		expect(mockRemote.remote.stopTailscaleServe).toHaveBeenCalledTimes(1);
		expect(routeAddress()).toBe("http://100.88.1.2:47833");
	});

	it("shows Tailscale's reason and its admin link when serving is turned off for the tailnet", async () => {
		const status = activeStatus();
		mockRemote.remote.status.mockResolvedValue(status);
		mockRemote.remote.startTailscaleServe.mockResolvedValue({
			...status,
			tailscale: { ...status.tailscale!, serveError: { reason: "Serve is not enabled on your tailnet.", enableUrl: "https://login.tailscale.com/f/serve?node=n1" } },
		});
		await render({ remoteAccess: true });
		await click(button("Tailscale"));
		await click(button("Publish over HTTPS in Tailnet"));

		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Tailscale refused: Serve is not enabled on your tailnet.");
		expect(button("Turn it on in the Tailscale admin console")).toBeDefined();
	});

	it("does not offer the Tailscale route at all when Tailscale is not installed on this computer", async () => {
		const status = activeStatus();
		mockRemote.remote.status.mockResolvedValue({
			...status,
			tailscale: { state: "missing", dnsName: null, tailnetIp: null, owner: null, servingUrl: null, serveCommand: null, serveUrl: null },
		});
		await render({ remoteAccess: true });

		const tabs = Array.from(container.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent);
		expect(tabs).toEqual(["Same Wi-Fi", "Internet"]);
		expect(routeAddress()).toBe("http://192.168.0.42:47833");
	});
});
