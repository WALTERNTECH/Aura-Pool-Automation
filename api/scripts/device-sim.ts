// Device simulator: behaves exactly like the ESP32 firmware over MQTT. Use the credentials the
// console shows once when you provision a table.
//
//   npm run sim:device -- --url wss://aura-pool-api.onrender.com/mqtt --device DXXXXXXX \
//        --password '...' --table T001 --secret '...'
//
// Keys while it runs: o = press the override button, x = drop off the network (last will),
// q = quit cleanly. Faults: --drop-acks, --always-busy, --skew <seconds>.

import readline from "node:readline";
import { VirtualDevice } from "../src/devices/simulator.js";

const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const need = (name: string) => {
  const v = arg(name) ?? process.env[`DEVICE_${name.toUpperCase()}`];
  if (!v) throw new Error(`--${name} is required`);
  return v;
};

async function main() {
  const dev = new VirtualDevice({
    url: arg("url", "ws://localhost:4000/mqtt")!,
    deviceId: need("device"),
    password: need("password"),
    tableId: need("table"),
    secret: need("secret"),
    firmware: "sim-cli-1.0.0",
    heartbeatMs: Number(arg("heartbeat", "30")) * 1000,
    faults: { dropAcks: process.argv.includes("--drop-acks"), alwaysBusy: process.argv.includes("--always-busy"), clockSkewS: Number(arg("skew", "0")) },
    log: (m) => console.log(new Date().toISOString().slice(11, 19), m),
  });
  await dev.connect();
  console.log("connected. o = override button, x = drop off the network, q = quit");
  if (!process.stdin.isTTY) return;
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on("keypress", async (_s, key) => {
    if (key.name === "o") {
      dev.pressOverride();
      console.log("override pressed");
    } else if (key.name === "x") {
      dev.crash();
      console.log("dropped off the network; the broker publishes the last will");
      process.exit(0);
    } else if (key.name === "q" || (key.ctrl && key.name === "c")) {
      await dev.close();
      process.exit(0);
    }
  });
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
