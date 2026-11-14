import { ipcMain } from "electron";
import { AGENT_CONNECT_CHANNELS, type AgentConnectStatus } from "../shared/agent-connect-contract";
import type { McpConnectInfo } from "../shared/settings-contract";
import { createAgentConnect, type AgentConnect } from "./agent-connect";
import { createTunnelManager } from "./remote/tunnel";

/**
 * Registers the agent-connection handlers and returns what the app needs to drive it from settings.
 *
 * It has its own tunnel manager, not the remote-access one: the two are independent switches with independent
 * addresses, and stopping one must never take the other down.
 */
export interface AgentConnectHost {
	/** Applies the persisted switch: starts or stops the server and tunnel. */
	apply(enabled: boolean): Promise<void>;
	setHostname(hostname: string): Promise<void>;
	stop(): Promise<void>;
}

export interface AgentConnectHostDeps {
	readonly stateDir: string;
	/** How to run the librarian server; `available: false` when this build has no server entry. */
	readonly launch: () => McpConnectInfo;
	readonly env: NodeJS.ProcessEnv;
	readonly hostname: () => Promise<string>;
	readonly onChanged: (status: AgentConnectStatus) => void;
}

export function registerAgentConnect(deps: AgentConnectHostDeps): AgentConnectHost {
	let manager: AgentConnect | null = null;
	const unavailable = (info: McpConnectInfo): AgentConnectStatus => ({
		serving: false,
		mcpUrl: null,
		oauth: false,
		allowWrite: false,
		tunnel: tunnel.status(),
		error: info.available ? null : "Dazzi's MCP server cannot be started on this computer.",
	});
	const tunnel = createTunnelManager({
		stateDir: deps.stateDir,
		onChange: () => {
			if (manager !== null) void manager.status().then(deps.onChanged, () => undefined);
		},
	});
	void deps.hostname().then((name) => tunnel.setHostname(name), () => undefined);

	const ensure = (): AgentConnect | null => {
		if (manager !== null) return manager;
		const info = deps.launch();
		if (!info.available) return null;
		manager = createAgentConnect({
			stateDir: deps.stateDir,
			launch: { command: info.command, args: info.args, env: info.env },
			env: deps.env,
			port: 0,
			tunnel,
			onChange: () => {
				if (manager !== null) void manager.status().then(deps.onChanged, () => undefined);
			},
		});
		return manager;
	};

	const statusOf = async (): Promise<AgentConnectStatus> => (await ensure()?.status()) ?? unavailable(deps.launch());
	const needed = (): AgentConnect => {
		const current = ensure();
		if (current === null) throw new Error("Dazzi's MCP server cannot be started on this computer.");
		return current;
	};

	ipcMain.handle(AGENT_CONNECT_CHANNELS.status, () => statusOf());
	ipcMain.handle(AGENT_CONNECT_CHANNELS.start, async () => (await ensure()?.start()) ?? unavailable(deps.launch()));
	ipcMain.handle(AGENT_CONNECT_CHANNELS.stop, async () => {
		await manager?.stop();
		return statusOf();
	});
	ipcMain.handle(AGENT_CONNECT_CHANNELS.setAllowWrite, (_event, allow: unknown) => needed().setAllowWrite(allow === true));
	ipcMain.handle(AGENT_CONNECT_CHANNELS.rotateToken, () => needed().rotateToken());
	ipcMain.handle(AGENT_CONNECT_CHANNELS.revealToken, () => needed().revealToken());
	ipcMain.handle(AGENT_CONNECT_CHANNELS.setHostname, async (_event, hostname: unknown) => {
		await tunnel.setHostname(typeof hostname === "string" ? hostname : "");
		return statusOf();
	});
	ipcMain.handle(AGENT_CONNECT_CHANNELS.loginTunnel, async () => {
		await tunnel.login();
		return statusOf();
	});

	return {
		apply: async (enabled) => {
			if (enabled) {
				await ensure()?.start();
				return;
			}
			await manager?.stop();
		},
		setHostname: (hostname) => tunnel.setHostname(hostname),
		stop: async () => {
			await manager?.stop();
		},
	};
}
