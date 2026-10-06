/**
 * Sponsor asset pipeline: sniff → validate → scan → store → optimize → moderate.
 *
 * Validation is by file CONTENT (magic bytes), never by the file name or the browser's
 * claimed type. Images are re-encoded into optimized variants, which also strips any
 * payload hidden in the original. SVGs are checked for active content and rasterized for
 * screens; the original is only ever served with a sandboxing CSP.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import sharp from 'sharp';
import { HttpError, id } from '../context.ts';
import type { DB } from '../db.ts';
import { now } from '../db.ts';

export const ASSET_KINDS = ['logo', 'logo_white', 'logo_dark', 'logo_transparent', 'banner', 'promo_image', 'video', 'ad_copy'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

interface Rule {
  label: string;
  mimes: string[];
  maxBytes: number;
  minWidth?: number;
  minHeight?: number;
  aspect?: [number, number]; // allowed width/height range
  alpha?: boolean; // must have transparency
  maxDurationMs?: number;
  maxChars?: number;
}

export const ASSET_RULES: Record<AssetKind, Rule> = {
  logo: { label: 'Logo', mimes: ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'], maxBytes: 5e6, minWidth: 300, minHeight: 80, aspect: [0.25, 8] },
  logo_white: { label: 'White logo (for dark screens)', mimes: ['image/png', 'image/webp', 'image/svg+xml'], maxBytes: 5e6, minWidth: 300, minHeight: 80, aspect: [0.25, 8], alpha: true },
  logo_dark: { label: 'Dark logo (for light backgrounds)', mimes: ['image/png', 'image/webp', 'image/svg+xml'], maxBytes: 5e6, minWidth: 300, minHeight: 80, aspect: [0.25, 8], alpha: true },
  logo_transparent: { label: 'Transparent logo', mimes: ['image/png', 'image/webp', 'image/svg+xml'], maxBytes: 5e6, minWidth: 300, minHeight: 80, aspect: [0.25, 8], alpha: true },
  banner: { label: 'Banner', mimes: ['image/png', 'image/jpeg', 'image/webp'], maxBytes: 8e6, minWidth: 1200, minHeight: 200, aspect: [1.5, 8] },
  promo_image: { label: 'Promotional image', mimes: ['image/png', 'image/jpeg', 'image/webp'], maxBytes: 8e6, minWidth: 600, minHeight: 600, aspect: [0.5, 2] },
  video: { label: 'Advertisement video (MP4, up to 30 s)', mimes: ['video/mp4'], maxBytes: 25e6, maxDurationMs: 30_000 },
  ad_copy: { label: 'Advertisement copy', mimes: ['text/plain'], maxBytes: 4000, maxChars: 280 },
};

/** Words that send copy to manual review (prohibited products, misleading claims). */
const FLAG_WORDS: Record<string, RegExp> = {
  tobacco: /\b(cigarettes?|tobacco|gutka|gutkha|vape|hookah|pan masala)\b/i,
  gambling: /\b(betting|casino|satta|jackpot|wager|bet now)\b/i,
  alcohol: /\b(whisky|whiskey|vodka|beer|rum|liquor|wine)\b/i,
  misleading: /\b(guaranteed (returns|results|cure)|100% cure|risk[- ]free returns|miracle)\b/i,
  adult: /\b(xxx|adult content|escort)\b/i,
};

export function screenText(text: string): string[] {
  return Object.entries(FLAG_WORDS).filter(([, re]) => re.test(text)).map(([k]) => k);
}

// ------------------------------------------------------------------ sniffing
export function sniff(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  const head = buf.subarray(0, 512).toString('utf8').replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

/** Reject SVGs that can execute or fetch anything (scripts, handlers, external refs, entities). */
export function svgProblems(svg: string): string[] {
  const p: string[] = [];
  if (/<script/i.test(svg)) p.push('contains a script');
  if (/\son[a-z]+\s*=/i.test(svg)) p.push('contains event handlers');
  if (/javascript:/i.test(svg)) p.push('contains a javascript: link');
  if (/<foreignObject/i.test(svg)) p.push('contains embedded HTML');
  if (/<!DOCTYPE|<!ENTITY/i.test(svg)) p.push('contains a DOCTYPE or entity declaration');
  if (/<(iframe|embed|object)\b/i.test(svg)) p.push('embeds other documents');
  if (/(?:xlink:)?href\s*=\s*["'](?!#)(?!data:image\/(png|jpeg|webp);base64,)/i.test(svg)) p.push('references external resources');
  if (/url\(\s*['"]?(?!#)/i.test(svg)) p.push('references external resources in styles');
  return p;
}

/** MP4 duration from the movie header box (moov/mvhd). */
export function mp4DurationMs(buf: Buffer): number | null {
  const walk = (start: number, end: number, want: string): [number, number] | null => {
    let o = start;
    while (o + 8 <= end) {
      let size = buf.readUInt32BE(o);
      const type = buf.toString('ascii', o + 4, o + 8);
      let header = 8;
      if (size === 1 && o + 16 <= end) {
        size = Number(buf.readBigUInt64BE(o + 8));
        header = 16;
      } else if (size === 0) size = end - o;
      if (size < header || o + size > end) return null;
      if (type === want) return [o + header, o + size];
      o += size;
    }
    return null;
  };
  const moov = walk(0, buf.length, 'moov');
  if (!moov) return null;
  const mvhd = walk(moov[0], moov[1], 'mvhd');
  if (!mvhd) return null;
  const v = buf[mvhd[0]];
  const body = mvhd[0] + 4;
  if (v === 1) {
    const ts = buf.readUInt32BE(body + 16);
    const dur = Number(buf.readBigUInt64BE(body + 20));
    return ts ? Math.round((dur / ts) * 1000) : null;
  }
  const ts = buf.readUInt32BE(body + 8);
  const dur = buf.readUInt32BE(body + 12);
  return ts ? Math.round((dur / ts) * 1000) : null;
}

// ------------------------------------------------------------------ malware scanning
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/** clamd INSTREAM when CLAMAV_HOST is set; built-in checks always run. */
export async function scan(buf: Buffer, mime: string): Promise<{ clean: boolean; reason?: string; engine: string }> {
  if (buf.includes(Buffer.from(EICAR))) return { clean: false, reason: 'EICAR test signature', engine: 'builtin' };
  // Images are never served as uploaded to the public: viewers only get re-encoded variants,
  // which drops anything smuggled into the original (polyglot files, trailing payloads).
  const host = process.env.CLAMAV_HOST;
  if (!host) return { clean: true, engine: 'builtin' };
  return new Promise((resolve) => {
    const sock = net.connect(Number(process.env.CLAMAV_PORT ?? 3310), host);
    let reply = '';
    sock.setTimeout(15000, () => {
      sock.destroy();
      resolve({ clean: false, reason: 'virus scanner timed out', engine: 'clamav' });
    });
    sock.on('connect', () => {
      sock.write('zINSTREAM\0');
      for (let o = 0; o < buf.length; o += 64 * 1024) {
        const chunk = buf.subarray(o, o + 64 * 1024);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length);
        sock.write(len);
        sock.write(chunk);
      }
      sock.write(Buffer.alloc(4));
    });
    sock.on('data', (d) => (reply += d.toString()));
    sock.on('end', () => resolve(/OK\0?$/.test(reply.trim()) ? { clean: true, engine: 'clamav' } : { clean: false, reason: reply.replace('stream: ', '').trim(), engine: 'clamav' }));
    sock.on('error', (e) => resolve({ clean: false, reason: `virus scanner unavailable (${e.message})`, engine: 'clamav' }));
  });
}

// ------------------------------------------------------------------ storage
export interface Storage {
  put(key: string, data: Buffer): void;
  get(key: string): Buffer | null;
  remove(key: string): void;
}

export class LocalStorage implements Storage {
  constructor(private root = path.resolve(process.env.DATA_DIR ?? 'data', 'assets')) {}
  private file(key: string) {
    const f = path.resolve(this.root, key);
    if (!f.startsWith(this.root)) throw new Error('bad key');
    return f;
  }
  put(key: string, data: Buffer) {
    const f = this.file(key);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, data);
  }
  get(key: string) {
    const f = this.file(key);
    return existsSync(f) ? readFileSync(f) : null;
  }
  remove(key: string) {
    const f = this.file(key);
    if (existsSync(f)) unlinkSync(f);
  }
}

/** In-memory storage for tests and ephemeral environments. */
export class MemoryStorage implements Storage {
  private m = new Map<string, Buffer>();
  put(k: string, d: Buffer) {
    this.m.set(k, d);
  }
  get(k: string) {
    return this.m.get(k) ?? null;
  }
  remove(k: string) {
    this.m.delete(k);
  }
}

// ------------------------------------------------------------------ service
export class AssetService {
  constructor(private db: DB, private storage: Storage) {}

  async upload(sponsorId: string, userId: string, kind: string, data: Buffer, originalName?: string): Promise<any> {
    if (!(ASSET_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, `kind must be one of ${ASSET_KINDS.join(', ')}`, 'VALIDATION');
    const rule = ASSET_RULES[kind as AssetKind];
    if (!data.length) throw new HttpError(400, 'The file is empty', 'VALIDATION');
    if (data.length > rule.maxBytes) throw new HttpError(413, `${rule.label} must be ${Math.round(rule.maxBytes / 1e6)} MB or smaller`, 'TOO_LARGE');

    if (kind === 'ad_copy') {
      const text = data.toString('utf8').trim();
      if (!text) throw new HttpError(400, 'Copy is empty', 'VALIDATION');
      if (text.length > rule.maxChars!) throw new HttpError(400, `Copy must be ${rule.maxChars} characters or fewer`, 'VALIDATION');
      const flags = screenText(text);
      return this.insert({ sponsorId, userId, kind, mime: 'text/plain', bytes: data.length, sha: sha(data), key: `copy/${sha(data)}.txt`, data, text, name: originalName, status: flags.length ? 'flagged' : 'ready', note: flags.length ? `Needs review: ${flags.join(', ')}` : null });
    }

    const mime = sniff(data);
    if (!mime || !rule.mimes.includes(mime)) throw new HttpError(415, `${rule.label} must be ${rule.mimes.map((m) => m.split('/')[1].replace('svg+xml', 'SVG').toUpperCase()).join(', ')}`, 'UNSUPPORTED_TYPE', { detected: mime });
    const verdict = await scan(data, mime);
    if (!verdict.clean) throw new HttpError(422, `This file was blocked by the security scan: ${verdict.reason}`, 'BLOCKED');
    const digest = sha(data);

    if (mime === 'video/mp4') {
      const dur = mp4DurationMs(data);
      if (dur == null) throw new HttpError(422, 'Could not read the video duration. Export as a standard MP4 (H.264).', 'VALIDATION');
      if (dur > rule.maxDurationMs!) throw new HttpError(422, `Video is ${(dur / 1000).toFixed(1)} s; the limit is ${rule.maxDurationMs! / 1000} s`, 'VALIDATION');
      return this.insert({ sponsorId, userId, kind, mime, bytes: data.length, sha: digest, key: `video/${digest}.mp4`, data, durationMs: dur, name: originalName, status: 'ready' });
    }

    if (mime === 'image/svg+xml') {
      const problems = svgProblems(data.toString('utf8'));
      if (problems.length) throw new HttpError(422, `This SVG can't be used because it ${problems.join(', ')}. Export a plain SVG or a PNG.`, 'VALIDATION');
    }
    let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
    try {
      meta = await sharp(data, { limitInputPixels: 50e6 }).metadata();
    } catch {
      throw new HttpError(422, 'This image could not be read. It may be corrupted.', 'VALIDATION');
    }
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (rule.minWidth && w < rule.minWidth) throw new HttpError(422, `${rule.label} must be at least ${rule.minWidth}px wide (this one is ${w}px)`, 'VALIDATION');
    if (rule.minHeight && h < rule.minHeight) throw new HttpError(422, `${rule.label} must be at least ${rule.minHeight}px tall (this one is ${h}px)`, 'VALIDATION');
    if (rule.aspect) {
      const r = w / h;
      if (r < rule.aspect[0] || r > rule.aspect[1]) throw new HttpError(422, `${rule.label} proportions are off: ${w}×${h} is ${r.toFixed(2)}:1, allowed ${rule.aspect[0]}:1 to ${rule.aspect[1]}:1`, 'VALIDATION');
    }
    if (rule.alpha && mime !== 'image/svg+xml' && !meta.hasAlpha) throw new HttpError(422, `${rule.label} needs a transparent background (PNG or WebP with transparency)`, 'VALIDATION');

    const ext = mime === 'image/svg+xml' ? 'svg' : mime.split('/')[1];
    const asset = this.insert({ sponsorId, userId, kind, mime, bytes: data.length, sha: digest, key: `orig/${digest}.${ext}`, data, width: w, height: h, name: originalName, status: 'ready' });
    await this.makeVariants(asset.id, data, kind);
    return this.get(asset.id);
  }

  /** Optimized renditions: re-encoded WebP (strips metadata and anything appended to the file). */
  private async makeVariants(assetId: string, data: Buffer, kind: string) {
    const sizes: [string, number][] = kind.startsWith('logo') ? [['thumb', 240], ['screen', 800]] : [['thumb', 480], ['screen', 1920]];
    for (const [variant, width] of sizes) {
      const out = await sharp(data, { density: 300, limitInputPixels: 50e6 }).resize({ width, withoutEnlargement: false, fit: 'inside' }).webp({ quality: 86, alphaQuality: 100 }).toBuffer({ resolveWithObject: true });
      const key = `var/${assetId}-${variant}.webp`;
      this.storage.put(key, out.data);
      this.db.prepare('INSERT OR REPLACE INTO asset_variants (asset_id, variant, mime, width, height, bytes, storage_key) VALUES (?,?,?,?,?,?,?)').run(
        assetId, variant, 'image/webp', out.info.width, out.info.height, out.data.length, key,
      );
    }
  }

  private insert(a: { sponsorId: string; userId: string; kind: string; mime: string; bytes: number; sha: string; key: string; data: Buffer; width?: number; height?: number; durationMs?: number; text?: string; name?: string; status: string; note?: string | null }) {
    this.storage.put(a.key, a.data);
    const aid = id();
    this.db.prepare(`INSERT INTO sponsor_assets (id, sponsor_id, kind, mime, bytes, width, height, duration_ms, sha256, storage_key, original_name, text, status, review_note, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      aid, a.sponsorId, a.kind, a.mime, a.bytes, a.width ?? null, a.height ?? null, a.durationMs ?? null, a.sha, a.key, a.name?.slice(0, 200) ?? null, a.text ?? null, a.status, a.note ?? null, a.userId, now(),
    );
    return this.get(aid);
  }

  get(assetId: string) {
    const a = this.db.prepare('SELECT * FROM sponsor_assets WHERE id = ?').get(assetId) as any;
    if (!a) throw new HttpError(404, 'Asset not found', 'NOT_FOUND');
    const variants = this.db.prepare('SELECT variant, width, height, bytes FROM asset_variants WHERE asset_id = ?').all(assetId) as any[];
    return {
      id: a.id, sponsorId: a.sponsor_id, kind: a.kind, mime: a.mime, bytes: a.bytes, width: a.width, height: a.height, durationMs: a.duration_ms,
      text: a.text, status: a.status, reviewNote: a.review_note, name: a.original_name, createdAt: a.created_at,
      url: a.kind === 'ad_copy' ? null : `/media/${a.id}`, variants: Object.fromEntries(variants.map((v) => [v.variant, { ...v, url: `/media/${a.id}?v=${v.variant}` }])),
    };
  }

  list(sponsorId: string) {
    return (this.db.prepare("SELECT id FROM sponsor_assets WHERE sponsor_id = ? AND status != 'deleted' ORDER BY created_at DESC").all(sponsorId) as any[]).map((r) => this.get(r.id));
  }

  remove(sponsorId: string, assetId: string) {
    const a = this.db.prepare('SELECT * FROM sponsor_assets WHERE id = ? AND sponsor_id = ?').get(assetId, sponsorId) as any;
    if (!a) throw new HttpError(404, 'Asset not found', 'NOT_FOUND');
    const inUse = this.db.prepare("SELECT 1 FROM sp_order_assets oa JOIN sp_orders o ON o.id = oa.order_id WHERE oa.asset_id = ? AND o.status IN ('ACTIVE','PAUSED','PENDING_APPROVAL','ASSET_REVIEW','PAYMENT_RECEIVED','PENDING_PAYMENT')").get(assetId);
    if (inUse) throw new HttpError(409, 'This asset is used by a live or pending sponsorship. Replace it there first.', 'CONFLICT');
    this.db.prepare("UPDATE sponsor_assets SET status = 'deleted' WHERE id = ?").run(assetId);
  }

  /** Bytes for serving (variant or original). */
  read(assetId: string, variant?: string | null): { data: Buffer; mime: string } | null {
    if (variant) {
      const v = this.db.prepare('SELECT * FROM asset_variants WHERE asset_id = ? AND variant = ?').get(assetId, variant) as any;
      if (v) {
        const data = this.storage.get(v.storage_key);
        return data ? { data, mime: v.mime } : null;
      }
    }
    const a = this.db.prepare('SELECT storage_key, mime FROM sponsor_assets WHERE id = ?').get(assetId) as any;
    if (!a) return null;
    const data = this.storage.get(a.storage_key);
    return data ? { data, mime: a.mime } : null;
  }

  /**
   * Who may fetch an asset. Public once it is part of an active sponsorship (screens and
   * live pages show it) or is the logo on a public sponsor profile; otherwise only the
   * sponsor's team, the organizers it was submitted to, and platform admins.
   */
  canView(assetId: string, viewer: { userId?: string; orgId?: string; platformAdmin?: boolean } | null): boolean {
    const a = this.db.prepare('SELECT sponsor_id, status FROM sponsor_assets WHERE id = ?').get(assetId) as any;
    if (!a || a.status === 'deleted') return false;
    const live = this.db.prepare("SELECT 1 FROM sp_order_assets oa JOIN sp_orders o ON o.id = oa.order_id WHERE oa.asset_id = ? AND oa.status = 'approved' AND o.status = 'ACTIVE'").get(assetId);
    if (live) return true;
    if (this.db.prepare("SELECT 1 FROM sponsor_accounts WHERE id = ? AND logo_asset_id = ? AND public_profile = 1 AND status = 'active'").get(a.sponsor_id, assetId)) return true;
    if (!viewer) return false;
    if (viewer.platformAdmin) return true;
    if (viewer.userId && this.db.prepare('SELECT 1 FROM sponsor_members WHERE sponsor_id = ? AND user_id = ?').get(a.sponsor_id, viewer.userId)) return true;
    if (viewer.orgId && this.db.prepare('SELECT 1 FROM sp_order_assets oa JOIN sp_orders o ON o.id = oa.order_id WHERE oa.asset_id = ? AND o.org_id = ?').get(assetId, viewer.orgId)) return true;
    return false;
  }

  /** Platform-level moderation (e.g. prohibited content), logged. */
  moderate(assetId: string, actorId: string, action: 'block' | 'clear', reason: string, note?: string) {
    const status = action === 'block' ? 'blocked' : 'ready';
    this.db.prepare('UPDATE sponsor_assets SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?').run(status, note ?? reason, actorId, now(), assetId);
    this.db.prepare('INSERT INTO moderation_log (subject_type, subject_id, action, reason, note, actor_id, at) VALUES (?,?,?,?,?,?,?)').run('asset', assetId, action, reason, note ?? null, actorId, now());
  }
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
