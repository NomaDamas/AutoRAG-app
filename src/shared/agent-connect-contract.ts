import type { RemoteTunnelStatus } from "./remote-contract";

/**
 * Connecting always-on cloud agents (Claude Duet, OpenAI dots, Meta Muse, Grok Bot) to this machine's index.
 * Shared by the main process (`agent-connect.ts`), its preload bridge and Settings → MCP 서버.
 *
 * This is not remote access (`remote-contract.ts`): that serves the Finder UI to a person behind a pairing code.
 * This serves search tools to an agent behind an owner token, over its own tunnel, and a remote browser session
 * never reaches it (it is not a bridge target, so the remote dispatcher has no route to it).
 */

export const AGENT_CONNECT_CHANNELS = {
	status: "agentConnect:status",
	start: "agentConnect:start",
	stop: "agentConnect:stop",
	setAllowWrite: "agentConnect:setAllowWrite",
	rotateToken: "agentConnect:rotateToken",
	revealToken: "agentConnect:revealToken",
	setHostname: "agentConnect:setHostname",
	loginTunnel: "agentConnect:loginTunnel",
	changed: "agentConnect:changed",
} as const;

export interface AgentConnectStatus {
	/** The server child is up and answering. */
	readonly serving: boolean;
	/** `https://<tunnel>/mcp`, the address to give the agent; null when there is no tunnel. */
	readonly mcpUrl: string | null;
	/** The server has a public address, which is what enables sign-in through OAuth. */
	readonly oauth: boolean;
	/** The write tools (refresh, report, convert) are offered to the agent. Off unless the user turns it on. */
	readonly allowWrite: boolean;
	readonly tunnel: RemoteTunnelStatus;
	readonly error: string | null;
}

export interface AgentConnectBridge {
	status(): Promise<AgentConnectStatus>;
	start(): Promise<AgentConnectStatus>;
	stop(): Promise<AgentConnectStatus>;
	setAllowWrite(allow: boolean): Promise<AgentConnectStatus>;
	/** A new owner token: every token the old one issued, OAuth sessions included, stops working. */
	rotateToken(): Promise<AgentConnectStatus>;
	/** The owner token, for an agent that sends it as a bearer header. Never part of `status`. */
	revealToken(): Promise<string>;
	/** Own Cloudflare domain for the agent address (`agents.example.com`); empty means a Quick Tunnel. */
	setHostname(hostname: string): Promise<AgentConnectStatus>;
	/** `cloudflared tunnel login`; opens Cloudflare in the host's browser. */
	loginTunnel(): Promise<AgentConnectStatus>;
	onChange(listener: (status: AgentConnectStatus) => void): () => void;
}
