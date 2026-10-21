import { ApiError } from '../errors.js';

export type ProxyType = 'http' | 'https' | 'socks5';
export interface ProxyInput { name?: string; type: ProxyType; host: string; port: number; username?: string | null; password?: string | null }

const SCHEMES: Record<string, ProxyType> = { http: 'http', https: 'https', socks5: 'socks5', socks5h: 'socks5', socks: 'socks5' };

// Accepts the formats proxy sellers hand out:
//   socks5://user:pass@host:port   user:pass@host:port   host:port:user:pass   host:port
export function parseProxyLine(line: string, defaultType: ProxyType): ProxyInput {
  const raw = line.trim();
  const bad = () => new ApiError(400, 'proxy_format', `Not a proxy address: ${raw.slice(0, 80)}`);
  if (!raw) throw bad();
  if (/^[a-z0-9]+:\/\//i.test(raw)){
    let u: URL;
    try { u = new URL(raw); } catch { throw bad(); }
    const type = SCHEMES[u.protocol.slice(0, -1).toLowerCase()];
    if (!type || !u.hostname || !u.port) throw bad();
    return { type, host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port), username: decodeURIComponent(u.username) || null, password: decodeURIComponent(u.password) || null };
  }
  const at = raw.lastIndexOf('@');
  if (at > 0){
    const [username, ...rest] = raw.slice(0, at).split(':');
    const [host, port] = raw.slice(at + 1).split(':');
    if (!host || !/^\d+$/.test(port ?? '')) throw bad();
    return { type: defaultType, host, port: Number(port), username, password: rest.join(':') || null };
  }
  const parts = raw.split(':');
  if (parts.length < 2 || !/^\d+$/.test(parts[1])) throw bad();
  return { type: defaultType, host: parts[0], port: Number(parts[1]), username: parts[2] || null, password: parts.slice(3).join(':') || null };
}
