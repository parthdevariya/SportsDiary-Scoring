export const session = {
  get token(): string | null {
    try { return localStorage.getItem('arena.token'); } catch { return null; }
  },
  set token(v: string | null) {
    try {
      if (v) localStorage.setItem('arena.token', v);
      else localStorage.removeItem('arena.token');
    } catch { /* ignore */ }
  },
};

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export async function api<T = any>(method: string, path: string, body?: any): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', ...(session.token ? { authorization: `Bearer ${session.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      session.token = null;
      location.href = `/?next=${encodeURIComponent(location.pathname + location.search)}`;
    }
    throw new ApiError(res.status, json?.error?.message ?? `Request failed (${res.status})`, json?.error?.code);
  }
  return json as T;
}

export const uuid = (): string =>
  (crypto as any).randomUUID?.() ??
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

export function toast(msg: string, kind: 'ok' | 'error' = 'ok') {
  let host = document.getElementById('toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3000);
}
