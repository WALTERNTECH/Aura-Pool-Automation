import { virtualDeviceCredentials } from "./devices.js";
import { VirtualDevice } from "./simulator.js";

// Sandbox tables with no hardware yet: the server runs a virtual ESP32 for each device marked
// virtual, connected to its own broker exactly as real firmware would, so the full payment →
// command → ack path runs end to end. Never runs against live Daraja.

const running = new Map<string, VirtualDevice>();
let brokerUrl = "";

export async function startVirtualDevices(url: string) {
  brokerUrl = url;
  await syncVirtualDevices();
}

export async function syncVirtualDevices() {
  if (!brokerUrl) return;
  const creds = await virtualDeviceCredentials();
  const want = new Map(creds.map((c) => [c.deviceId, c]));
  for (const [id, dev] of running) {
    const c = want.get(id);
    if (!c || c.password !== dev.o.password || c.tableId !== dev.o.tableId) {
      await dev.close().catch(() => {});
      running.delete(id);
    }
  }
  for (const c of creds) {
    if (running.has(c.deviceId)) continue;
    const dev = new VirtualDevice({ url: brokerUrl, deviceId: c.deviceId, password: c.password, tableId: c.tableId, secret: c.secret, firmware: "virtual-1.0.0", heartbeatMs: 30_000 });
    running.set(c.deviceId, dev);
    dev.connect().catch((e) => console.error(`[virtual] ${c.tableId} failed to connect:`, (e as Error).message));
  }
}

export function virtualSummary() {
  return [...running.values()].map((d) => ({ deviceId: d.o.deviceId, tableId: d.o.tableId, relayOn: d.relayOn, unlocks: d.unlocks, overridePresses: d.presses }));
}

export async function virtualAction(tableId: string, action: "override" | "offline" | "online"): Promise<boolean> {
  const dev = [...running.values()].find((d) => d.o.tableId === tableId);
  if (!dev) {
    if (action === "online") {
      await syncVirtualDevices();
      return [...running.values()].some((d) => d.o.tableId === tableId);
    }
    return false;
  }
  if (action === "override") dev.pressOverride(20);
  if (action === "offline") {
    dev.crash();
    running.delete(dev.o.deviceId);
  }
  return true;
}

export async function stopVirtualDevices() {
  for (const d of running.values()) await d.close().catch(() => {});
  running.clear();
}
