/**
 * Discovers active local-network IPv4 origins (`http://192.168.x.y:<port>`)
 * so phones and laptops on the same Wi-Fi/LAN can scan a QR code directly
 * without replacing `localhost` by hand.
 */
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

/** `100.64.0.0/10` (RFC 6598 carrier-grade NAT): never a usable LAN address on this machine. */
function isCgnatAddress(address: string): boolean {
	const octets = address.split(".");
	if (octets.length !== 4) return false;
	const first = Number(octets[0]);
	const second = Number(octets[1]);
	return Number.isInteger(first) && Number.isInteger(second) && first === 100 && second >= 64 && second <= 127;
}

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
			if (!ip || ip.startsWith("127.") || ip.startsWith("169.254.") || isCgnatAddress(ip)) continue;
			seen.add(`http://${ip}:${port}`);
		}
	}
	return [...seen];
}
