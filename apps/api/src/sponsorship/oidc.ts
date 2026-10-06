/**
 * Sign in with Google / Apple: verify the provider's ID token (RS256 JWT) on the server.
 * The browser only ever hands us the token; identity comes from the verified claims.
 *
 * Enabled per provider by GOOGLE_CLIENT_ID / APPLE_CLIENT_ID (Apple: the Services ID).
 */
import { createPublicKey, verify as verifySig } from 'node:crypto';

export interface OidcProvider {
  name: 'google' | 'apple';
  issuers: string[];
  jwksUrl: string;
  clientId: () => string | undefined;
}

export const PROVIDERS: Record<'google' | 'apple', OidcProvider> = {
  google: { name: 'google', issuers: ['https://accounts.google.com', 'accounts.google.com'], jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs', clientId: () => process.env.GOOGLE_CLIENT_ID },
  apple: { name: 'apple', issuers: ['https://appleid.apple.com'], jwksUrl: 'https://appleid.apple.com/auth/keys', clientId: () => process.env.APPLE_CLIENT_ID },
};

type JwksFetcher = (url: string) => Promise<{ keys: any[] }>;
const cache = new Map<string, { at: number; keys: any[] }>();
let fetcher: JwksFetcher = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`JWKS ${r.status}`);
  return (await r.json()) as any;
};
/** Tests inject a fetcher serving their own keys. */
export const setJwksFetcher = (f: JwksFetcher) => {
  fetcher = f;
  cache.clear();
};

async function keysFor(url: string, refresh = false) {
  const c = cache.get(url);
  if (c && !refresh && Date.now() - c.at < 3600_000) return c.keys;
  const { keys } = await fetcher(url);
  cache.set(url, { at: Date.now(), keys });
  return keys;
}

const b64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export interface VerifiedIdentity {
  sub: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
}

export async function verifyIdToken(p: OidcProvider, token: string, nowSec = Math.floor(Date.now() / 1000)): Promise<VerifiedIdentity> {
  const aud = p.clientId();
  if (!aud) throw new Error(`${p.name} sign-in is not configured`);
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const header = JSON.parse(b64url(parts[0]).toString('utf8'));
  const claims = JSON.parse(b64url(parts[1]).toString('utf8'));
  if (header.alg !== 'RS256') throw new Error('Unsupported token algorithm');
  let keys = await keysFor(p.jwksUrl);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await keysFor(p.jwksUrl, true); // provider rotated keys
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error('Unknown signing key');
  const ok = verifySig('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), b64url(parts[2]));
  if (!ok) throw new Error('Invalid token signature');
  if (!p.issuers.includes(claims.iss)) throw new Error('Wrong token issuer');
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) throw new Error('Token was issued for a different app');
  if (typeof claims.exp !== 'number' || claims.exp < nowSec - 60) throw new Error('Token expired');
  if (typeof claims.iat === 'number' && claims.iat > nowSec + 300) throw new Error('Token issued in the future');
  const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
  return { sub: String(claims.sub), email: claims.email, emailVerified, name: claims.name, picture: claims.picture };
}
