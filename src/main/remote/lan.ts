/**
 * Discovers active local-network IPv4 origins (`http://192.168.x.y:<port>`)
 * so phones and laptops on the same Wi-Fi/LAN can scan a QR code directly
 * without replacing `localhost` by hand.
 */
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { isTailnetIp } from "./tailscale";

export function discoverLanOrigins(
	port: number,
	interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string[] {
	if (port <= 0) return [];
	const seen = new Set<string>();
	for (const entries of Object.values(interfaces)) {
		if (!entries) continue;
		for (const entry of entries) {
			if (entry.internal) continue;
			if (entry.family !== "IPv4") continue;
			const ip = entry.address.trim();
			if (!ip || ip.startsWith("127.") || ip.startsWith("169.254.") || isTailnetIp(ip)) continue;
			seen.add(`http://${ip}:${port}`);
		}
	}
	return [...seen];
}
