import type { Server } from "node:http";
import net from "node:net";
import { Aedes, type Client } from "aedes";
import mqtt from "mqtt";
import { createWebSocketStream, WebSocketServer } from "ws";
import { parseTopic } from "./protocol.js";

// How commands reach tables. Two interchangeable transports:
//
//  embedded  An MQTT broker inside this process, served as MQTT-over-WebSocket on /mqtt of
//            the API's own HTTPS port (Render exposes one port, TLS terminated in front).
//            Each device signs in with its own credentials and may only use its own topics.
//            MQTT_TCP_PORT additionally opens plain MQTT for a bench on the local network.
//  external  This server is one client of a broker you run (EMQX, Mosquitto) on 8883 with
//            TLS. That broker authenticates devices through /internal/mqtt/auth and /acl.

export type Incoming = { tableId: string; kind: "ack" | "status" | "event"; payload: unknown; deviceId: string | null };
export type DeviceIdentity = { deviceId: string; tableId: string };

export interface DeviceTransport {
  readonly kind: "embedded" | "external";
  start(server: Server): Promise<void>;
  publish(topic: string, payload: object): Promise<void>;
  onMessage(fn: (m: Incoming) => void): void;
  onDisconnect(fn: (id: DeviceIdentity) => void): void;
  disconnect(deviceId: string): void;
  status(): { kind: string; connected: boolean; clients: number; detail: string };
  stop(): Promise<void>;
}

type Authenticator = (username: string, password: string) => Promise<DeviceIdentity | null>;
const SERVER_ID = "aura-server";

export class EmbeddedTransport implements DeviceTransport {
  readonly kind = "embedded" as const;
  private broker: Aedes | null = null;
  private wss: WebSocketServer | null = null;
  private tcp: net.Server | null = null;
  private handlers: ((m: Incoming) => void)[] = [];
  private gone: ((id: DeviceIdentity) => void)[] = [];
  private clients = new Map<string, Client>();
  private identities = new WeakMap<Client, DeviceIdentity>();

  constructor(
    private auth: Authenticator,
    private tcpPort?: number,
  ) {}

  async start(server: Server) {
    const broker = await Aedes.createBroker({
      id: "aura-embedded",
      heartbeatInterval: 60_000,
      authenticate: (client, username, password, done) => {
        this.auth(String(username ?? ""), password ? password.toString("utf8") : "")
          .then((id) => {
            if (!id || client.id !== id.deviceId) {
              const err = Object.assign(new Error("Bad username or password"), { returnCode: 4 });
              return done(err as never, false);
            }
            this.identities.set(client, id);
            done(null, true);
          })
          .catch(() => done(Object.assign(new Error("Server unavailable"), { returnCode: 3 }) as never, false));
      },
      authorizePublish: (client, packet, done) => {
        if (!client) return done(null); // the server itself
        const id = this.identities.get(client);
        const t = parseTopic(packet.topic);
        if (!id || !t || t.tableId !== id.tableId || t.kind === "cmd") return done(new Error("Not allowed to publish there"));
        done(null);
      },
      authorizeSubscribe: (client, sub, done) => {
        const id = this.identities.get(client);
        // A null subscription is refused with SUBACK 0x80 (MQTT 3.1.1, 3.9.3); an error alone isn't.
        if (!id || sub.topic !== `pool/${id.tableId}/cmd`) return done(null, null);
        done(null, sub);
      },
    });
    broker.on("clientReady", (client) => {
      const prior = this.clients.get(client.id);
      if (prior && prior !== client) prior.close();
      this.clients.set(client.id, client);
    });
    broker.on("clientDisconnect", (client) => {
      if (this.clients.get(client.id) === client) this.clients.delete(client.id);
      const id = this.identities.get(client);
      if (id) for (const fn of this.gone) fn(id);
    });
    broker.on("publish", (packet, client) => {
      const t = parseTopic(packet.topic);
      if (!t || t.kind === "cmd") return;
      const id = client ? this.identities.get(client) : null;
      // A last will is published on the device's behalf; trust its topic only if it is the device's own.
      if (client && (!id || id.tableId !== t.tableId)) return;
      if (!client && t.kind !== "status") return;
      let payload: unknown = null;
      try {
        payload = JSON.parse(packet.payload.toString("utf8"));
      } catch {
        return;
      }
      for (const fn of this.handlers) fn({ tableId: t.tableId, kind: t.kind, payload, deviceId: id?.deviceId ?? null });
    });
    this.broker = broker;

    this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, handleProtocols: (protocols) => (protocols.has("mqtt") ? "mqtt" : false) });
    this.wss.on("connection", (ws, req) => broker.handle(createWebSocketStream(ws), req));
    server.on("upgrade", (req, socket, head) => {
      if (!req.url || !req.url.startsWith("/mqtt")) {
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.wss!.emit("connection", ws, req));
    });
    if (this.tcpPort) {
      this.tcp = net.createServer((s) => broker.handle(s));
      await new Promise<void>((res) => this.tcp!.listen(this.tcpPort, res));
    }
  }

  publish(topic: string, payload: object) {
    return new Promise<void>((resolve, reject) => {
      if (!this.broker) return reject(new Error("broker not started"));
      this.broker.publish({ cmd: "publish", topic, payload: Buffer.from(JSON.stringify(payload)), qos: 1, retain: false, dup: false }, (err) => (err ? reject(err) : resolve()));
    });
  }
  onMessage(fn: (m: Incoming) => void) {
    this.handlers.push(fn);
  }
  onDisconnect(fn: (id: DeviceIdentity) => void) {
    this.gone.push(fn);
  }
  disconnect(deviceId: string) {
    this.clients.get(deviceId)?.close();
  }
  status() {
    return { kind: "embedded", connected: Boolean(this.broker && !this.broker.closed), clients: this.clients.size, detail: `MQTT over WebSocket on /mqtt${this.tcpPort ? ` and TCP :${this.tcpPort}` : ""}` };
  }
  async stop() {
    for (const c of this.clients.values()) c.close();
    this.wss?.close();
    this.tcp?.close();
    await new Promise<void>((res) => (this.broker ? this.broker.close(() => res()) : res()));
  }
}

export class ExternalTransport implements DeviceTransport {
  readonly kind = "external" as const;
  private client: mqtt.MqttClient | null = null;
  private handlers: ((m: Incoming) => void)[] = [];

  constructor(private opts: { url: string; username: string; password: string }) {}

  async start() {
    this.client = mqtt.connect(this.opts.url, {
      clientId: `${SERVER_ID}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`,
      username: this.opts.username,
      password: this.opts.password,
      reconnectPeriod: 2_000,
      connectTimeout: 10_000,
      clean: true,
    });
    this.client.on("connect", () => {
      this.client!.subscribe(["pool/+/ack", "pool/+/status", "pool/+/event"], { qos: 1 });
    });
    this.client.on("error", (e) => console.error("[mqtt] external broker:", e.message));
    this.client.on("message", (topic, buf) => {
      const t = parseTopic(topic);
      if (!t || t.kind === "cmd") return;
      let payload: unknown = null;
      try {
        payload = JSON.parse(buf.toString("utf8"));
      } catch {
        return;
      }
      for (const fn of this.handlers) fn({ tableId: t.tableId, kind: t.kind, payload, deviceId: null });
    });
  }
  publish(topic: string, payload: object) {
    return new Promise<void>((resolve, reject) => {
      if (!this.client) return reject(new Error("not connected"));
      this.client.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => (err ? reject(err) : resolve()));
    });
  }
  onMessage(fn: (m: Incoming) => void) {
    this.handlers.push(fn);
  }
  onDisconnect() {
    // The broker's last will reaches us as a status message.
  }
  disconnect() {
    // Revocation takes effect at the broker's next auth check.
  }
  status() {
    return { kind: "external", connected: Boolean(this.client?.connected), clients: -1, detail: this.opts.url.replace(/\/\/[^@]*@/, "//") };
  }
  async stop() {
    await new Promise<void>((res) => (this.client ? this.client.end(false, {}, () => res()) : res()));
  }
}
