/**
 * Real-time client shared by TV, live page, scorer and console.
 * - Reconnects forever with capped exponential backoff + jitter (no manual refresh, ever).
 * - Re-sends subscriptions / display hello after every reconnect, so the server always
 *   replies with an authoritative snapshot before streaming deltas.
 * - Tracks server clock offset so match clocks render identically on every screen.
 */
export type RtState = 'connecting' | 'connected' | 'offline';

export class Realtime {
  private ws: WebSocket | null = null;
  private topics = new Set<string>();
  private hello: any = null;
  private handlers = new Set<(m: any) => void>();
  private stateHandlers = new Set<(s: RtState) => void>();
  private attempt = 0;
  private timer: any = null;
  private hb: any = null;
  state: RtState = 'connecting';
  /** serverNow ≈ Date.now() + offset */
  offset = 0;
  lastMessageAt = 0;

  constructor(private token?: string | null) {
    this.connect();
    window.addEventListener('online', () => this.reconnectSoon(0));
  }

  private url() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws${this.token ? `?token=${encodeURIComponent(this.token)}` : ''}`;
  }

  private setState(s: RtState) {
    if (this.state === s) return;
    this.state = s;
    this.stateHandlers.forEach((f) => f(s));
  }

  private connect() {
    this.setState(this.attempt === 0 ? 'connecting' : 'offline');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url());
    } catch {
      return this.reconnectSoon();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.setState('connected');
      if (this.hello) this.raw(this.hello);
      this.topics.forEach((t) => this.raw({ t: 'sub', topic: t }));
      clearInterval(this.hb);
      this.hb = setInterval(() => this.raw({ t: 'ping' }), 20000);
    };
    ws.onmessage = (ev) => {
      let m: any;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.lastMessageAt = Date.now();
      if (typeof m.serverTime === 'number') this.offset = m.serverTime - Date.now();
      this.handlers.forEach((f) => f(m));
    };
    ws.onclose = () => {
      clearInterval(this.hb);
      if (this.ws === ws) this.reconnectSoon();
    };
    ws.onerror = () => ws.close();
  }

  private reconnectSoon(delay?: number) {
    clearTimeout(this.timer);
    this.setState('offline');
    const d = delay ?? Math.min(15000, 500 * 2 ** this.attempt) * (0.7 + Math.random() * 0.6);
    this.attempt++;
    this.timer = setTimeout(() => this.connect(), d);
  }

  raw(m: any) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  sub(topic: string) {
    this.topics.add(topic);
    this.raw({ t: 'sub', topic });
  }

  unsub(topic: string) {
    this.topics.delete(topic);
    this.raw({ t: 'unsub', topic });
  }

  setHello(m: any) {
    this.hello = m;
    this.raw(m);
  }

  on(f: (m: any) => void) {
    this.handlers.add(f);
    return () => this.handlers.delete(f);
  }

  onState(f: (s: RtState) => void) {
    this.stateHandlers.add(f);
    f(this.state);
  }

  serverNow() {
    return Date.now() + this.offset;
  }
}
