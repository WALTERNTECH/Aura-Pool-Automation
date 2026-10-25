import mqtt from "mqtt";
import { checkCommand, MAX_ON_SECONDS, topics, type Command } from "./protocol.js";

// A virtual ESP32 that speaks the device protocol exactly as the firmware does: it checks
// signature, expiry and duplicates; acks busy while the relay is on; caps on-time at 60 s;
// sends a heartbeat every 30 s with a last will; and can press its override button.
// Used by scripts/device-sim.ts, by the sandbox's in-process virtual tables, and by tests.

export type SimOptions = {
  url: string;
  deviceId: string;
  password: string;
  tableId: string;
  secret: string;
  firmware?: string;
  heartbeatMs?: number;
  /** Testing faults. */
  faults?: { dropAcks?: boolean; clockSkewS?: number; alwaysBusy?: boolean };
  log?: (m: string) => void;
};

export class VirtualDevice {
  private client: mqtt.MqttClient | null = null;
  private relayUntil = 0;
  private recent: string[] = [];
  private beat: NodeJS.Timeout | null = null;
  private startedAt = Date.now();
  unlocks = 0;
  presses = 0;
  readonly t: ReturnType<typeof topics>;

  constructor(readonly o: SimOptions) {
    this.t = topics(o.tableId);
  }

  get relayOn() {
    return Date.now() < this.relayUntil;
  }

  private nowS() {
    return Math.floor(Date.now() / 1000) + (this.o.faults?.clockSkewS ?? 0);
  }

  private log(m: string) {
    this.o.log?.(`[${this.o.tableId}/${this.o.deviceId}] ${m}`);
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const c = mqtt.connect(this.o.url, {
        clientId: this.o.deviceId,
        username: this.o.deviceId,
        password: this.o.password,
        protocolVersion: 4,
        keepalive: 30,
        reconnectPeriod: 3_000,
        connectTimeout: 10_000,
        will: { topic: this.t.status, payload: Buffer.from(JSON.stringify({ online: false })), qos: 1, retain: true },
      });
      this.client = c;
      let first = true;
      c.on("connect", () => {
        c.subscribe(this.t.cmd, { qos: 1 }, (err) => {
          if (err) this.log(`subscribe failed: ${err.message}`);
          this.status();
          if (first) {
            first = false;
            this.event({ type: "boot" });
            resolve();
          }
        });
      });
      c.on("error", (e) => {
        this.log(`mqtt error: ${e.message}`);
        if (first) {
          first = false;
          c.end(true);
          reject(e);
        }
      });
      c.on("message", (_topic, buf) => this.onCommand(buf));
      this.beat = setInterval(() => this.status(), this.o.heartbeatMs ?? 30_000);
      this.beat.unref?.();
    });
  }

  private onCommand(buf: Buffer) {
    let cmd: Partial<Command>;
    try {
      cmd = JSON.parse(buf.toString("utf8"));
    } catch {
      return;
    }
    const v = checkCommand(cmd, this.o.secret, this.nowS(), this.recent);
    if (!v.ok) {
      this.log(`rejected ${cmd.cmd_id}: ${v.reason}`);
      return this.ack(cmd.cmd_id ?? "", "rejected", v.reason);
    }
    if (this.relayOn || this.o.faults?.alwaysBusy) return this.ack(cmd.cmd_id!, "busy", "relay_on");
    this.recent.push(cmd.cmd_id!);
    if (this.recent.length > 50) this.recent.shift();
    this.runRelay(Math.min(cmd.duration_s!, MAX_ON_SECONDS));
    this.unlocks++;
    this.log(`unlocked for ${cmd.duration_s}s (${cmd.cmd_id})`);
    this.ack(cmd.cmd_id!, "ok");
  }

  private runRelay(seconds: number) {
    this.relayUntil = Date.now() + seconds * 1000;
    this.status();
    setTimeout(() => this.status(), seconds * 1000 + 20).unref?.();
  }

  private ack(cmdId: string, result: "ok" | "rejected" | "busy", reason?: string) {
    if (this.o.faults?.dropAcks) return;
    this.client?.publish(this.t.ack, JSON.stringify({ cmd_id: cmdId, result, reason, ts: this.nowS() }), { qos: 1 });
  }

  status() {
    this.client?.publish(
      this.t.status,
      JSON.stringify({ online: true, fw: this.o.firmware ?? "sim-1.0.0", rssi: -55 - Math.round(Math.random() * 20), uptime_s: Math.round((Date.now() - this.startedAt) / 1000), relay: this.relayOn ? "on" : "off", ip: "10.0.0.42", ts: this.nowS() }),
      { qos: 1, retain: true },
    );
  }

  event(e: Record<string, unknown>) {
    this.client?.publish(this.t.event, JSON.stringify({ ...e, ts: this.nowS() }), { qos: 1 });
  }

  /** The physical override button: a local unlock of the usual duration, reported to the server. */
  pressOverride(durationS = 20) {
    this.presses++;
    if (!this.relayOn) this.runRelay(Math.min(durationS, MAX_ON_SECONDS));
    this.event({ type: "manual_override", duration_s: durationS });
  }

  /** Disappears without a clean goodbye, so the broker publishes the last will. */
  crash() {
    if (this.beat) clearInterval(this.beat);
    this.client?.stream.destroy();
    this.client?.end(true);
    this.client = null;
  }

  async close() {
    if (this.beat) clearInterval(this.beat);
    await new Promise<void>((res) => (this.client ? this.client.end(false, {}, () => res()) : res()));
    this.client = null;
  }
}
