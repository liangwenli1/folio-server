// Where an IP address is: city and coordinates from the DB-IP City Lite database (CC BY 4.0, attribution
// "IP Geolocation by DB-IP" wherever results are shown), time zone from the coordinates (geo-tz, full set,
// so Kuala Lumpur stays Asia/Kuala_Lumpur), and a default browser language for the country.
import { isIP } from 'node:net';
import { find as findTimezone } from 'geo-tz/all';
import { open as openMmdb, type Reader, type CityResponse } from 'maxmind';
import type { Config } from './config.js';

export interface Geo {
  country: string; countryName: string; region: string | null; city: string | null;
  lat: number; lon: number; timezone: string; locale: string;
}

// Most common browser language per country; anything else falls back to en-US. Profiles can override it.
const LOCALES: Record<string, string> = {
  US: 'en-US', GB: 'en-GB', CA: 'en-CA', AU: 'en-AU', NZ: 'en-NZ', IE: 'en-IE', IN: 'en-IN', SG: 'en-SG', PH: 'en-PH', ZA: 'en-ZA',
  NG: 'en-NG', KE: 'en-KE', MY: 'ms-MY', ID: 'id-ID', TH: 'th-TH', VN: 'vi-VN', JP: 'ja-JP', KR: 'ko-KR', CN: 'zh-CN', TW: 'zh-TW',
  HK: 'zh-HK', DE: 'de-DE', AT: 'de-AT', CH: 'de-CH', FR: 'fr-FR', BE: 'nl-BE', NL: 'nl-NL', LU: 'fr-LU', ES: 'es-ES', PT: 'pt-PT',
  IT: 'it-IT', PL: 'pl-PL', CZ: 'cs-CZ', SK: 'sk-SK', HU: 'hu-HU', RO: 'ro-RO', BG: 'bg-BG', GR: 'el-GR', SE: 'sv-SE', NO: 'nb-NO',
  DK: 'da-DK', FI: 'fi-FI', EE: 'et-EE', LV: 'lv-LV', LT: 'lt-LT', UA: 'uk-UA', RU: 'ru-RU', TR: 'tr-TR', IL: 'he-IL', SA: 'ar-SA',
  AE: 'ar-AE', EG: 'ar-EG', MA: 'ar-MA', MX: 'es-MX', AR: 'es-AR', CO: 'es-CO', CL: 'es-CL', PE: 'es-PE', BR: 'pt-BR', PK: 'en-PK',
  BD: 'bn-BD', HR: 'hr-HR', RS: 'sr-RS', SI: 'sl-SI'
};
export const localeFor = (country: string) => LOCALES[country] ?? 'en-US';

const DEV_CITIES: Record<string, Omit<Geo, 'timezone' | 'locale'>> = {
  seattle: { country: 'US', countryName: 'United States', region: 'Washington', city: 'Seattle', lat: 47.6062, lon: -122.3321 },
  london: { country: 'GB', countryName: 'United Kingdom', region: 'England', city: 'London', lat: 51.5072, lon: -0.1276 },
  tokyo: { country: 'JP', countryName: 'Japan', region: 'Tokyo', city: 'Tokyo', lat: 35.6762, lon: 139.6503 },
  frankfurt: { country: 'DE', countryName: 'Germany', region: 'Hesse', city: 'Frankfurt am Main', lat: 50.1109, lon: 8.6821 },
  newyork: { country: 'US', countryName: 'United States', region: 'New York', city: 'New York', lat: 40.7128, lon: -74.006 },
  singapore: { country: 'SG', countryName: 'Singapore', region: 'Singapore', city: 'Singapore', lat: 1.2897, lon: 103.8501 }
};
// In dev, documentation addresses (RFC 5737) stand for exits around the world: the ones the desktop's demo proxies
// report (folio-desktop/demo/world.ts).
const DEV_EXITS: Record<string, keyof typeof DEV_CITIES> = {
  '203.0.113.24': 'seattle', '203.0.113.71': 'newyork', '198.51.100.16': 'london', '198.51.100.92': 'tokyo', '192.0.2.45': 'frankfurt', '192.0.2.130': 'singapore'
};

const readers = new Map<string, Promise<Reader<CityResponse>>>();
const readerFor = (path: string) => {
  if (!readers.has(path)) readers.set(path, openMmdb<CityResponse>(path));
  return readers.get(path)!;
};

const PRIVATE = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^127\./, /^169\.254\./, /^::1$/, /^f[cd]/i, /^fe80:/i];
const isPrivate = (ip: string) => PRIVATE.some(r => r.test(ip.replace(/^::ffff:/, '')));

const complete = (g: Omit<Geo, 'timezone' | 'locale'>): Geo =>
  ({ ...g, timezone: findTimezone(g.lat, g.lon)[0] ?? 'UTC', locale: localeFor(g.country) });

export async function locate(ip: string, config: Pick<Config, 'devTools' | 'devPrivateGeo' | 'geoipDb'>): Promise<Geo | null> {
  const addr = ip.replace(/^::ffff:/, '');
  if (!isIP(addr)) return null;
  if (isPrivate(addr)) return config.devTools && DEV_CITIES[config.devPrivateGeo] ? complete(DEV_CITIES[config.devPrivateGeo]) : null;
  if (config.devTools && DEV_EXITS[addr]) return complete(DEV_CITIES[DEV_EXITS[addr]]);
  if (!config.geoipDb) return null;
  const r = (await readerFor(config.geoipDb)).get(addr);
  if (!r?.location || !r.country) return null;
  return complete({
    country: r.country.iso_code, countryName: r.country.names?.en ?? r.country.iso_code,
    region: r.subdivisions?.[0]?.names?.en ?? null, city: r.city?.names?.en ?? null,
    lat: r.location.latitude, lon: r.location.longitude
  });
}
