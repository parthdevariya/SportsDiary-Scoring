/**
 * Real-time hub. Clients subscribe to topics; services publish to topics.
 * Topics:  match:<publicCode>  tournament:<publicCode>  display:<deviceId>  org:<orgId>
 *
 * The in-process `LocalBus` is the single-node implementation. In a multi-node
 * deployment the same `Bus` interface is backed by Redis/NATS pub-sub so that a score
 * accepted on node A reaches a TV connected to node B.
 */
import type { WebSocket } from 'ws';

export interface Bus {
  publish(topic: string, msg: any): void;
  onMessage(fn: (topic: string, msg: any) => void): void;
}

export class LocalBus implements Bus {
  private fns: ((topic: string, msg: any) => void)[] = [];
  publish(topic: string, msg: any) {
    for (const f of this.fns) f(topic, msg);
  }
  onMessage(fn: (topic: string, msg: any) => void) {
    this.fns.push(fn);
  }
}

export interface Client {
  ws: WebSocket;
  topics: Set<string>;
  deviceId?: string;
  userId?: string;
  alive: boolean;
}

export class Hub {
  clients = new Set<Client>();
  private byTopic = new Map<string, Set<Client>>();

  constructor(private bus: Bus = new LocalBus()) {
    bus.onMessage((topic, msg) => this.deliver(topic, msg));
  }

  add(ws: WebSocket): Client {
    const c: Client = { ws, topics: new Set(), alive: true };
    this.clients.add(c);
    return c;
  }

  remove(c: Client) {
    for (const t of c.topics) this.byTopic.get(t)?.delete(c);
    this.clients.delete(c);
  }

  subscribe(c: Client, topic: string) {
    c.topics.add(topic);
    let set = this.byTopic.get(topic);
    if (!set) this.byTopic.set(topic, (set = new Set()));
    set.add(c);
  }

  unsubscribe(c: Client, topic: string) {
    c.topics.delete(topic);
    this.byTopic.get(topic)?.delete(c);
  }

  /** Replace a client's subscriptions (used when a display's assignment changes). */
  setTopics(c: Client, topics: string[], keep: (t: string) => boolean = () => false) {
    for (const t of [...c.topics]) if (!keep(t) && !topics.includes(t)) this.unsubscribe(c, t);
    for (const t of topics) this.subscribe(c, t);
  }

  publish(topic: string, msg: any) {
    this.bus.publish(topic, msg);
  }

  private deliver(topic: string, msg: any) {
    const set = this.byTopic.get(topic);
    if (!set?.size) return;
    const data = JSON.stringify({ ...msg, topic, serverTime: Date.now() });
    for (const c of set) send(c, data);
  }

  subscribers(topic: string): number {
    return this.byTopic.get(topic)?.size ?? 0;
  }

  displayClients(deviceId: string): Client[] {
    return [...this.clients].filter((c) => c.deviceId === deviceId);
  }
}

export function send(c: Client, data: string | object) {
  if (c.ws.readyState !== 1) return;
  try {
    c.ws.send(typeof data === 'string' ? data : JSON.stringify({ ...data, serverTime: Date.now() }));
  } catch {
    /* socket closing */
  }
}
