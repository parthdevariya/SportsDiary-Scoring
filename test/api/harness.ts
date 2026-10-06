import { WebSocket } from 'ws';
import { createApp, type App } from '../../apps/api/src/app.ts';

export interface Harness {
  app: App;
  base: string;
  wsUrl: string;
  api(method: string, path: string, body?: any, token?: string): Promise<any>;
  close(): Promise<void>;
}

export async function start(): Promise<Harness> {
  const app = createApp({ dbFile: ':memory:', rateLimitScale: 1000 });
  await new Promise<void>((r) => app.server.listen(0, r));
  const port = (app.server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  return {
    app,
    base,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    async api(method, path, body, token) {
      const res = await fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (!res.ok) {
        const err: any = new Error(json?.error?.message ?? res.statusText);
        err.status = res.status;
        err.body = json;
        throw err;
      }
      return json;
    },
    close: () => app.close(),
  };
}

/** Minimal real-time client used to play the role of a TV / spectator. */
export class Socket {
  ws: WebSocket;
  messages: any[] = [];
  private waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  opened: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((r) => this.ws.once('open', () => r()));
    this.ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      this.messages.push(m);
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
    });
  }

  send(m: any) {
    this.ws.send(JSON.stringify(m));
  }

  /** Wait for the next matching message (ignores ones already received unless `past`). */
  next(pred: (m: any) => boolean, ms = 3000, past = false): Promise<any> {
    if (past) {
      const hit = this.messages.find(pred);
      if (hit) return Promise.resolve(hit);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for message; last: ${JSON.stringify(this.messages.at(-1))?.slice(0, 300)}`)), ms);
      this.waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  }

  close() {
    this.ws.close();
  }
}

export async function registerOrg(h: Harness, name = 'Riverside Club', email = `admin+${Math.random().toString(36).slice(2)}@example.com`) {
  const r = await h.api('POST', '/api/auth/register', { orgName: name, name: 'Admin', email, password: 'correct horse battery' });
  return r.token as string;
}

/** Register a TV like a fresh browser would, connect, and pair it. */
export async function pairTv(h: Harness, token: string, name: string, assignment?: any) {
  const reg = await h.api('POST', '/api/displays/register', { resolution: '1920x1080' });
  const tv = new Socket(h.wsUrl);
  await tv.opened;
  tv.send({ t: 'display.hello', deviceId: reg.deviceId, secret: reg.secret });
  const first = await tv.next((m) => m.t === 'display.config', 3000, true);
  const paired = tv.next((m) => m.t === 'display.config' && m.device.paired);
  const dev = await h.api('POST', '/api/displays/pair', { code: first.device.pairingCode, name, assignment }, token);
  await paired;
  return { tv, deviceId: reg.deviceId as string, secret: reg.secret as string, display: dev, firstConfig: first };
}
