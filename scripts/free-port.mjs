/**
 * Free-port discovery for local dev runs. A port is reserved with an
 * ephemeral bind and then released, so `make run` can hand distinct,
 * currently-unused ports to the Vite dev server, the main-process V8
 * inspector, and the renderer remote-debugging endpoint.
 */

import { createServer } from "node:net";

/**
 * Reserve one port, then release it. The probe binds every interface (the
 * default host), so a port that looks free is free on IPv4 and IPv6 alike:
 * Vite serves the renderer on ::1 and Electron binds its inspector to
 * 127.0.0.1, and one free family alone would not keep them apart.
 */
export function findFreePort() {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.unref();
		probe.once("error", reject);
		probe.listen(0, () => {
			const address = probe.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			probe.close((error) => (error ? reject(error) : resolve(port)));
		});
	});
}

/** Distinct free ports, so no two endpoints of one run share a port. */
export async function findFreePorts(count) {
	const ports = new Set();
	while (ports.size < count) {
		ports.add(await findFreePort());
	}
	return [...ports];
}
