import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import { networkInterfaces, platform } from "node:os";

/** Chromium advertises its WebRTC host candidates as random UUID .local names. */
export async function observeMdns() {
	const sockets: Socket[] = [];
	const names: string[] = [];
	const controlName = randomUUID();
	const controls = new Set<string>();
	const route = createSocket("udp4");
	await new Promise<void>(resolve => route.connect(5353, "224.0.0.251", resolve));
	const defaultAddress = route.address().address;
	route.close();
	const interfaces = Object.entries(networkInterfaces());
	const zone = (name: string, addresses: NonNullable<ReturnType<typeof networkInterfaces>[string]>) => {
		const address = addresses.find(address => address.family === "IPv6" && !address.internal && address.scopeid > 0)
			?? addresses.find(address => address.family === "IPv6" && !address.internal);
		if (!address) return undefined;
		return platform() === "win32" ? String((address as { scopeid: number }).scopeid) : name;
	};
	const defaultInterface = interfaces.find(([, addresses]) => addresses?.some(address => address.address === defaultAddress));
	const defaultZone = defaultInterface && zone(defaultInterface[0], defaultInterface[1]!);
	const close = () => Promise.all(sockets.map(socket => new Promise<void>(resolve => socket.close(resolve))));
	try {
		for (const type of ["udp4", "udp6"] as const) {
			const socket = createSocket({ type, reuseAddr: true, ipv6Only: type === "udp6" });
			sockets.push(socket);
			socket.on("message", packet => {
				for (const match of packet.toString("latin1").matchAll(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\x05local\x00/gi)) {
					if (match[1] === controlName) controls.add(type);
					else names.push(match[1]!);
				}
			});
			await new Promise<void>((resolve, reject) => {
				socket.once("error", reject);
				socket.bind(5353, type === "udp4" ? "0.0.0.0" : "::", () => { socket.off("error", reject); resolve(); });
			});
			if (type === "udp4") socket.addMembership("224.0.0.251");
			else {
				if (defaultZone) {
					socket.setMulticastInterface(`::%${defaultZone}`);
					socket.addMembership("ff02::fb", `::%${defaultZone}`);
				}
			}
			// Multicast controls verify reception despite other processes sharing 5353.
			socket.setMulticastLoopback(true);
			const packet = Buffer.concat([Buffer.alloc(12), Buffer.from([36]), Buffer.from(controlName), Buffer.from([5]), Buffer.from("local"), Buffer.from([0, 0, 1, 0, 1])]);
			packet.writeUInt16BE(1, 4);
			await new Promise<void>((resolve, reject) => {
				const deadline = setTimeout(() => { socket.off("message", received); reject(new Error(`${type} mDNS control was not received`)); }, 2_000);
				const received = () => { if (controls.has(type)) { clearTimeout(deadline); socket.off("message", received); resolve(); } };
				socket.on("message", received);
				socket.send(packet, 5353, type === "udp4" ? "224.0.0.251" : defaultZone ? `ff02::fb%${defaultZone}` : "::1", error => {
					if (error) { clearTimeout(deadline); socket.off("message", received); reject(error); }
				});
			});
		}
		assert.equal(controls.size, 2);
		return { names, controls: controls.size, close };
	} catch (error) { await close(); throw error; }
}
