import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { proxies } from '../db/schema.js';
import { open, seal } from '../crypto.js';
import { ApiError } from '../errors.js';

export type ProxyType = 'http' | 'https' | 'socks5';
export interface ProxyInput { name?: string; type: ProxyType; host: string; port: number; username?: string | null; password?: string | null; notes?: string | null }

const SCHEMES: Record<string, ProxyType> = { http: 'http', https: 'https', socks5: 'socks5', socks5h: 'socks5', socks: 'socks5' };

// Accepts the formats proxy sellers hand out:
//   socks5://user:pass@host:port   user:pass@host:port   host:port:user:pass   host:port
// A line that isn't one says why: 'proxy_port' when the port isn't a number from 1 to 65535, else 'proxy_format'.
export function parseProxyLine(line: string, defaultType: ProxyType): ProxyInput {
  const raw = line.trim();
  const bad = () => new ApiError(400, 'proxy_format', `Not a proxy address: ${raw.slice(0, 80)}`);
  const port = (p: string | undefined) => {
    if (!/^\d+$/.test(p ?? '') || Number(p) < 1 || Number(p) > 65535) throw new ApiError(400, 'proxy_port', `Not a port from 1 to 65535: ${raw.slice(0, 80)}`);
    return Number(p);
  };
  if (!raw) throw bad();
  if (/^[a-z0-9]+:\/\//i.test(raw)){
    let u: URL;
    try { u = new URL(raw); } catch { throw bad(); }
    const type = SCHEMES[u.protocol.slice(0, -1).toLowerCase()];
    if (!type || !u.hostname) throw bad();
    return { type, host: u.hostname.replace(/^\[|\]$/g, ''), port: port(u.port), username: decodeURIComponent(u.username) || null, password: decodeURIComponent(u.password) || null };
  }
  const at = raw.lastIndexOf('@');
  if (at > 0){
    const [username, ...rest] = raw.slice(0, at).split(':');
    const [host, p] = raw.slice(at + 1).split(':');
    if (!host) throw bad();
    return { type: defaultType, host, port: port(p), username, password: rest.join(':') || null };
  }
  const parts = raw.split(':');
  if (parts.length < 2 || !parts[0]) throw bad();
  return { type: defaultType, host: parts[0], port: port(parts[1]), username: parts[2] || null, password: parts.slice(3).join(':') || null };
}

export const proxyRow = (workspaceId: string, i: ProxyInput & { backupId?: string | null }, now: Date) => ({
  workspaceId, name: i.name || `${i.host}:${i.port}`, type: i.type, host: i.host, port: i.port, notes: i.notes || null,
  username: i.username || null, passwordEnc: i.password ? seal(i.password) : null, backupId: i.backupId ?? null, createdAt: now, updatedAt: now
});

// Two proxies are the same line when type, address, username and password are.
export const proxyKey = (p: ProxyInput) => JSON.stringify([p.type, p.host.toLowerCase(), p.port, p.username || null, p.password || null]);
export async function savedProxies(db: Db, workspaceId: string){
  const rows = await db.select().from(proxies).where(eq(proxies.workspaceId, workspaceId));
  return new Map(rows.map(p => [proxyKey({ type: p.type as ProxyType, host: p.host, port: p.port, username: p.username, password: p.passwordEnc ? open(p.passwordEnc) : null }), p]));
}

// The saved proxy for each input: one identical to a saved or an earlier input is reused (unless `reuse` is off, when
// every input is added), the rest are added, named by `name` (counting the added ones from 1) when given. Returns
// them in input order, and how many were new.
export async function saveProxies(db: Db, workspaceId: string, inputs: ProxyInput[], now: Date, { reuse = true, name }: { reuse?: boolean; name?: (n: number) => string } = {}){
  const known = reuse ? await savedProxies(db, workspaceId) : new Map<string, typeof proxies.$inferSelect>();
  const fresh = reuse ? [...new Map(inputs.filter(p => !known.has(proxyKey(p))).reverse().map(p => [proxyKey(p), p])).values()].reverse() : inputs;
  const rows = fresh.length ? await db.insert(proxies).values(fresh.map((p, i) => proxyRow(workspaceId, name ? { ...p, name: name(i + 1) } : p, now))).returning() : [];
  if (!reuse) return { saved: rows, added: rows.length };
  fresh.forEach((p, i) => known.set(proxyKey(p), rows[i]));
  return { saved: inputs.map(i => known.get(proxyKey(i))!), added: rows.length };
}
