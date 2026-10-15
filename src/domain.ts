import net from "node:net";
import tls from "node:tls";
import { cachedFetch } from "./cache.js";

export const IANA_BOOTSTRAP = "https://data.iana.org/rdap/dns.json";
export const PORKBUN_PRICING = "https://api.porkbun.com/api/json/v3/pricing/get";
const DOH = "https://cloudflare-dns.com/dns-query";
const DAY = 86400_000;

// ---------- validation ----------
export function normaliseDomain(input: string) {
  let d = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  try { d = new URL("http://" + d).hostname; } catch { /* fallthrough */ }
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(d)) throw new Error(`"${input}" is not a valid domain name (punycode IDNs like xn--... are accepted).`);
  return d;
}
export const tldOf = (d: string) => d.slice(d.lastIndexOf(".") + 1);

// ---------- brainstorming (deterministic) ----------
const STOP = new Set("a an the and or for of to in on with my our your app platform tool service that which help helps people who is are be by from at as it this".split(" "));
const PREFIXES = ["get", "try", "go", "use", "hey", "meet", "join", "my"];
const SUFFIXES = ["ly", "ify", "io", "hub", "lab", "base", "kit", "hq", "able", "flow", "nest", "wise", "loop", "craft"];
export function keywords(idea: string) { return [...new Set(idea.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)))]; }
const vowels = /[aeiouy]/;
export function pronounceability(name: string) {
  let score = 1; const runs = name.match(/[^aeiouy]{3,}/g) ?? [];
  score -= runs.reduce((a, r) => a + (r.length - 2) * 0.15, 0);
  if (!vowels.test(name)) score -= 0.5;
  if (/(.)\1\1/.test(name)) score -= 0.3;
  return Math.max(0, +score.toFixed(2));
}
const METHOD_BONUS: Record<string, number> = { compound: 0.15, suffix: 0.1, prefix: 0.06, "vowel drop": 0.04, portmanteau: 0, keyword: -0.35 };
export function brandScore(name: string, method = "compound") {
  const len = name.length; const lenScore = len < 5 ? 0.6 : len <= 8 ? 1 : len <= 11 ? 0.8 : len <= 14 ? 0.55 : 0.3;
  const kind = Object.keys(METHOD_BONUS).find(k => method.includes(k)) ?? (method.includes("+ \"") ? "suffix" : method.includes("\" +") ? "prefix" : "compound");
  return +((lenScore * 0.45 + pronounceability(name) * 0.4 + (/\d|-/.test(name) ? 0 : 0.1) + (METHOD_BONUS[kind] ?? 0))).toFixed(3);
}
export function brainstorm(idea: string, count = 30, extraWords: string[] = []) {
  const kw = [...keywords(idea), ...extraWords.map(w => w.toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean)];
  if (!kw.length) throw new Error("Describe the idea with at least one meaningful word (e.g. 'AI tutor for kids').");
  const out = new Map<string, string>();
  const add = (n: string, how: string) => { if (n.length >= 3 && n.length <= 20 && !out.has(n)) out.set(n, how); };
  for (const w of kw) {
    add(w, "keyword");
    for (const s of SUFFIXES) add((/^[aeiouy]/.test(s) && /[aeiouy]$/.test(w) ? w.slice(0, -1) : w) + s, `suffix: keyword + "${s}"`);
    for (const p of PREFIXES) add(p + w, `prefix: "${p}" + keyword`);
    if (w.length > 5) add(w.replace(/([^aeiou])[aeiou]([^aeiou])$/, "$1$2"), "vowel drop (Flickr-style)");
  }
  for (let i = 0; i < kw.length; i++) for (let j = 0; j < kw.length; j++) if (i !== j) {
    const a = kw[i], b = kw[j];
    add(a + b, "compound");
    // portmanteau only where the words overlap on a shared letter (e.g. "brunch" style), so blends stay readable
    for (let k = Math.min(a.length - 1, 4); k >= 2; k--) { const tail = a.slice(-k); const at = b.indexOf(tail[tail.length - 1]); if (at > 0 && at < 3) { add(a.slice(0, a.length - 1) + b.slice(at), "portmanteau"); break; } }
  }
  return [...out.entries()].map(([name, method]) => ({ name, method, score: brandScore(name, method) }))
    .sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name))
    // diversity: at most 2 names per (method kind, root keyword)
    .filter(function (this: Map<string, number>, n) { const kind = n.method.split(":")[0]; const root = kw.find(w => n.name.includes(w.slice(0, 4))) ?? n.name; const k = kind + "|" + root; const c = this.get(k) ?? 0; this.set(k, c + 1); return c < 2; }, new Map<string, number>())
    .slice(0, count);
}

// ---------- RDAP ----------
export async function rdapBase(tld: string) {
  const f = await cachedFetch<any>(IANA_BOOTSTRAP, DAY);
  for (const [tlds, urls] of f.data.services) if (tlds.includes(tld)) return { base: (urls.find((u: string) => u.startsWith("https")) ?? urls[0]) as string, bootstrapFetchedAt: f.fetchedAt };
  return null;
}
export interface Availability { domain: string; status: "available" | "likely-available" | "registered" | "unknown"; method: "RDAP" | "WHOIS" | "DNS" | "none"; source: string; checkedAt: string; expires?: string; registrar?: string; statuses?: string[]; dropSignal?: string; note?: string; }

export function dropSignal(statuses: string[] = [], expires?: string) {
  const s = statuses.map(x => x.toLowerCase());
  if (s.some(x => x.includes("pending delete"))) return "Pending delete: likely to drop and become registrable within ~5 days";
  if (s.some(x => x.includes("redemption"))) return "In redemption period: owner can still restore it; may drop in ~30-35 days";
  if (expires) { const days = (new Date(expires).getTime() - Date.now()) / DAY; if (days < 0) return `Expired ${Math.round(-days)} days ago (grace period; owner can still renew)`; if (days < 30) return `Expires in ${Math.round(days)} days`; }
  return undefined;
}

export async function rdapLookup(domain: string): Promise<{ availability: Availability; raw?: any }> {
  const d = normaliseDomain(domain); const b = await rdapBase(tldOf(d)); const now = new Date().toISOString();
  if (!b) return { availability: { domain: d, status: "unknown", method: "none", source: IANA_BOOTSTRAP, checkedAt: now, note: `.${tldOf(d)} has no RDAP service in the IANA bootstrap` } };
  const url = `${b.base.replace(/\/?$/, "/")}domain/${d}`;
  const f = await cachedFetch<any>(url, 5 * 60_000, { allow404: true, accept: "application/rdap+json, application/json" });
  if (f.data?.__notFound) return { availability: { domain: d, status: "available", method: "RDAP", source: url, checkedAt: f.fetchedAt, note: "Registry RDAP returned 404 (no such registration). Premium/reserved names can still be unavailable at checkout." } };
  const r = f.data;
  const exp = r.events?.find((e: any) => e.eventAction === "expiration")?.eventDate;
  const regEnt = r.entities?.find((e: any) => e.roles?.includes("registrar"));
  const registrar = regEnt?.vcardArray?.[1]?.find((v: any) => v[0] === "fn")?.[3] ?? regEnt?.publicIds?.[0]?.identifier;
  return { availability: { domain: d, status: "registered", method: "RDAP", source: url, checkedAt: f.fetchedAt, expires: exp, registrar, statuses: r.status, dropSignal: dropSignal(r.status, exp) }, raw: r };
}

// ---------- WHOIS (port 43) ----------
export function whoisQuery(server: string, query: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = ""; const sock = net.connect(43, server);
    sock.setTimeout(timeoutMs, () => { sock.destroy(); reject(new Error(`WHOIS timeout (${server})`)); });
    sock.on("connect", () => sock.write(query + "\r\n"));
    sock.on("data", d => { buf += d.toString("utf8"); if (buf.length > 200_000) sock.destroy(); });
    sock.on("end", () => resolve(buf)); sock.on("close", () => resolve(buf)); sock.on("error", reject);
  });
}
const whoisServerCache = new Map<string, string | null>();
let whoisBlockedUntil = 0;
export async function whoisServerFor(tld: string) {
  if (whoisServerCache.has(tld)) return whoisServerCache.get(tld)!;
  if (Date.now() < whoisBlockedUntil) throw new Error("WHOIS (TCP port 43) unreachable from this host");
  let txt: string;
  try { txt = await whoisQuery("whois.iana.org", tld); } catch (e) { whoisBlockedUntil = Date.now() + 10 * 60_000; throw e; }
  const m = txt.match(/^whois:\s*(\S+)/im); const s = m ? m[1] : null; whoisServerCache.set(tld, s); return s;
}
const NOT_FOUND = /(no match|not found|no data found|no entries found|status:\s*(free|available)|is available|domain not found|no object found|nothing found|not registered|is free)/i;
export function parseWhois(text: string) {
  const available = NOT_FOUND.test(text) && !/^\s*(creation date|created|registered on|registrar:)/im.test(text);
  const exp = text.match(/^\s*(?:registry expiry date|expiry date|expiration date|expires on|paid-till|renewal date)\s*:\s*(.+)$/im)?.[1]?.trim();
  const registrar = text.match(/^\s*registrar(?: name)?\s*:\s*(.+)$/im)?.[1]?.trim();
  const statuses = [...text.matchAll(/^\s*(?:domain )?status\s*:\s*(\S+)/gim)].map(m => m[1]);
  return { available, expires: exp, registrar, statuses };
}
export async function whoisLookup(domain: string) {
  const d = normaliseDomain(domain); const server = await whoisServerFor(tldOf(d));
  if (!server) throw new Error(`No WHOIS server listed by IANA for .${tldOf(d)}`);
  const raw = await whoisQuery(server, d);
  if (/limit exceeded|too many requests|quota/i.test(raw)) throw new Error(`WHOIS server ${server} is rate-limiting; try later.`);
  return { server, raw, parsed: parseWhois(raw) };
}

export async function checkAvailability(domain: string): Promise<Availability> {
  const d = normaliseDomain(domain);
  try {
    const r = await rdapLookup(d);
    if (r.availability.status !== "unknown") return r.availability;
  } catch (e) { /* fall through to WHOIS */ }
  try {
    const w = await whoisLookup(d); const now = new Date().toISOString();
    return { domain: d, status: w.parsed.available ? "available" : "registered", method: "WHOIS", source: `whois://${w.server}`, checkedAt: now, expires: w.parsed.expires, registrar: w.parsed.registrar, statuses: w.parsed.statuses, dropSignal: w.parsed.available ? undefined : dropSignal(w.parsed.statuses, w.parsed.expires), note: "WHOIS fallback (text heuristics); verify at a registrar before relying on it." };
  } catch (e) {
    // Last resort: DNS. NS records prove registration; NXDOMAIN only suggests availability.
    try {
      const r = await dnsStatus(d);
      if (r === "has-ns") return { domain: d, status: "registered", method: "DNS", source: "Cloudflare DNS-over-HTTPS", checkedAt: new Date().toISOString(), note: "Has nameservers (registered). RDAP unavailable for this TLD and WHOIS unreachable." };
      if (r === "nxdomain") return { domain: d, status: "likely-available", method: "DNS", source: "Cloudflare DNS-over-HTTPS", checkedAt: new Date().toISOString(), note: "No DNS delegation (NXDOMAIN). Likely available, but registered-without-DNS names exist: confirm at a registrar." };
    } catch { /* ignore */ }
    return { domain: d, status: "unknown", method: "none", source: "-", checkedAt: new Date().toISOString(), note: `Could not check: ${(e as Error).message}` };
  }
}

export async function dnsStatus(domain: string): Promise<"has-ns" | "nxdomain" | "no-ns"> {
  const f = await cachedFetch<any>(`${DOH}?name=${domain}&type=NS`, 60_000, { accept: "application/dns-json" });
  if (f.data.Status === 3) return "nxdomain";
  const all = [...(f.data.Answer ?? []), ...(f.data.Authority ?? [])];
  return all.some((a: any) => a.type === 2 && a.name.replace(/\.$/, "").toLowerCase() === domain) ? "has-ns" : (f.data.Answer ?? []).length ? "has-ns" : "no-ns";
}

export async function mapLimit<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>) {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

// ---------- pricing (Porkbun public pricing endpoint; no auth) ----------
export interface Price { tld: string; registration: number; renewal: number; transfer: number; currency: "USD"; source: string; registrar: string; fetchedAt: string; coupon?: string }
export async function tldPrices(tlds: string[]): Promise<{ prices: Record<string, Price | null>; fetchedAt: string; source: string }> {
  const f = await cachedFetch<any>(PORKBUN_PRICING, 6 * 3600_000, { method: "POST", body: "{}" });
  if (f.data?.status !== "SUCCESS") throw new Error("Porkbun pricing endpoint did not return SUCCESS");
  const prices: Record<string, Price | null> = {};
  for (const t of tlds) {
    const p = f.data.pricing?.[t];
    prices[t] = p ? { tld: t, registration: Number(p.registration), renewal: Number(p.renewal), transfer: Number(p.transfer), currency: "USD", registrar: "Porkbun", source: PORKBUN_PRICING, fetchedAt: f.fetchedAt, coupon: p.coupons?.[0] ? `${p.coupons[0].code ?? ""} ${p.coupons[0].amount ?? ""}`.trim() : undefined } : null;
  }
  return { prices, fetchedAt: f.fetchedAt, source: PORKBUN_PRICING };
}

// ---------- DNS (DoH) and TLS ----------
export async function dnsLookup(domain: string, types: string[]) {
  const d = normaliseDomain(domain); const res: Record<string, { data: string; ttl: number }[]> = {}; let fetchedAt = "";
  await Promise.all(types.map(async t => {
    const f = await cachedFetch<any>(`${DOH}?name=${d}&type=${t}`, 60_000, { accept: "application/dns-json" });
    fetchedAt = f.fetchedAt;
    res[t] = (f.data.Answer ?? []).map((a: any) => ({ data: a.data, ttl: a.TTL }));
  }));
  return { domain: d, records: res, resolver: "Cloudflare DNS-over-HTTPS (1.1.1.1)", fetchedAt };
}

export function sslCert(domain: string, port = 443): Promise<any> {
  const d = normaliseDomain(domain);
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: d, port, servername: d, rejectUnauthorized: false, timeout: 10000 }, () => {
      const c = sock.getPeerCertificate(true); const authorized = sock.authorized; const authError = sock.authorizationError;
      const proto = sock.getProtocol(); sock.end();
      if (!c || !c.valid_to) return reject(new Error("No certificate presented"));
      const daysLeft = Math.floor((new Date(c.valid_to).getTime() - Date.now()) / DAY);
      resolve({ domain: d, subject: c.subject?.CN, issuer: [c.issuer?.O, c.issuer?.CN].filter(Boolean).join(" / "), validFrom: new Date(c.valid_from).toISOString(), validTo: new Date(c.valid_to).toISOString(), daysLeft,
        altNames: (c.subjectaltname ?? "").split(", ").map((s: string) => s.replace(/^DNS:/, "")).filter(Boolean).slice(0, 50), serialNumber: c.serialNumber, fingerprint256: c.fingerprint256,
        trusted: authorized, trustError: authError ? String(authError) : null, protocol: proto, checkedAt: new Date().toISOString() });
    });
    sock.on("timeout", () => { sock.destroy(); reject(new Error(`TLS timeout connecting to ${d}:${port}`)); });
    sock.on("error", e => reject(new Error(`TLS connection to ${d}:${port} failed: ${e.message}`)));
  });
}

// ---------- marketplace pointers (links only; no data fabricated) ----------
export function aftermarketLinks(domain: string) {
  const d = normaliseDomain(domain); const label = d.split(".")[0];
  return [
    { name: "Afternic (GoDaddy) listing search", url: `https://www.afternic.com/domain/${d}` },
    { name: "Sedo listing search", url: `https://sedo.com/search/?keyword=${encodeURIComponent(d)}` },
    { name: "Dan.com / GoDaddy Aftermarket", url: `https://www.godaddy.com/domainsearch/find?domainToCheck=${encodeURIComponent(d)}` },
    { name: "ExpiredDomains.net (expiring/deleted lists)", url: `https://www.expireddomains.net/domain-name-search/?q=${encodeURIComponent(label)}` },
  ];
}
export function purchaseLink(domain: string, registrar: "porkbun" | "namecheap" | "cloudflare") {
  const d = normaliseDomain(domain);
  const url = registrar === "porkbun" ? `https://porkbun.com/checkout/search?q=${encodeURIComponent(d)}` : registrar === "namecheap" ? `https://www.namecheap.com/domains/registration/results/?domain=${encodeURIComponent(d)}` : `https://domains.cloudflare.com/?domain=${encodeURIComponent(d)}`;
  return { domain: d, registrar, url };
}
