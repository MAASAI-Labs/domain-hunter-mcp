import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as D from "./domain.js";

const DEFAULT_TLDS = ["com", "io", "ai", "co", "app", "dev", "xyz"];
const tldList = z.array(z.string().regex(/^[a-z0-9-]{2,63}(\.[a-z0-9-]{2,63})?$/i, "TLD like 'com' or 'co.uk' (no dot prefix)")).max(12).optional();
const run = (fn: (a: any) => Promise<{ markdown: string } & Record<string, unknown>>) => async (a: any) => {
  try { const r = await fn(a); return { content: [{ type: "text" as const, text: r.markdown }, { type: "text" as const, text: "```json\n" + JSON.stringify({ ...r, markdown: undefined }, null, 2) + "\n```" }] }; }
  catch (e) { return { isError: true, content: [{ type: "text" as const, text: (e as Error).message }] }; }
};
const money = (n?: number) => n === undefined || Number.isNaN(n) ? "-" : `$${n.toFixed(2)}`;
const PRICE_NOTE = (at: string) => `_Prices: Porkbun public pricing API (${D.PORKBUN_PRICING}), USD list prices, fetched ${at}. Other registrars differ; premium names cost more and are priced at checkout._`;

async function availabilityTable(domains: string[]) {
  const results = await D.mapLimit(domains, 6, d => D.checkAvailability(d));
  let pricing: Awaited<ReturnType<typeof D.tldPrices>> | null = null; let priceErr = "";
  try { pricing = await D.tldPrices([...new Set(results.map(r => D.tldOf(r.domain)))]); } catch (e) { priceErr = (e as Error).message; }
  const rows = results.map(r => ({ ...r, price: pricing?.prices[D.tldOf(r.domain)] ?? null }));
  let md = `| Domain | Status | First year | Renewal | Checked via | Notes |\n|---|---|---:|---:|---|---|\n`;
  for (const r of rows) md += `| ${r.domain} | ${r.status === "available" ? "✅ available" : r.status === "likely-available" ? "🟡 likely available" : r.status === "registered" ? "❌ registered" : "❔ unknown"} | ${r.status.includes("available") ? money(r.price?.registration) : "-"} | ${r.status.includes("available") ? money(r.price?.renewal) : "-"} | ${r.method} | ${[r.dropSignal, r.status === "registered" && r.expires ? `expires ${r.expires.slice(0, 10)}` : "", r.method === "WHOIS" ? "WHOIS heuristic" : "", r.method === "DNS" || r.status === "unknown" ? r.note : ""].filter(Boolean).join("; ")} |\n`;
  md += `\n_Availability: live registry RDAP (servers from IANA bootstrap ${D.IANA_BOOTSTRAP}) with WHOIS then DNS fallback, checked ${new Date().toISOString()}._\n`;
  md += pricing ? PRICE_NOTE(pricing.fetchedAt) : `_Pricing unavailable: ${priceErr}. No prices shown rather than guessed._`;
  return { rows, md };
}

export function createServer() {
  const server = new McpServer({ name: "domain-hunter-mcp", version: "1.0.0" });
  const ro = { readOnlyHint: true, openWorldHint: true };

  server.registerTool("brainstorm_domains", { title: "Brainstorm brandable domains", annotations: ro,
    description: "Generate brandable name ideas from a product idea (compounds, portmanteaus, suffixes, prefixes, vowel drops), ranked by length/pronounceability, then check live availability and list prices across TLDs.",
    inputSchema: { idea: z.string().min(3).max(300), tlds: tldList.describe(`default ${DEFAULT_TLDS.slice(0, 3).join(", ")}`), count: z.number().int().min(1).max(30).optional().describe("names to generate (default 12)"), extraWords: z.array(z.string().max(30)).max(10).optional(), check: z.boolean().optional().describe("check availability (default true; max 60 lookups)") } },
    run(async a => {
      const names = D.brainstorm(a.idea, a.count ?? 12, a.extraWords ?? []);
      const tlds = (a.tlds ?? DEFAULT_TLDS.slice(0, 3)).map((t: string) => t.toLowerCase());
      let md = `## Name ideas for "${a.idea}"\n\n`;
      if (a.check === false) {
        md += names.map((n, i) => `${i + 1}. **${n.name}** (${n.method}, score ${n.score})`).join("\n");
        return { names, markdown: md };
      }
      const domains = names.flatMap(n => tlds.map((t: string) => `${n.name}.${t}`)).slice(0, 60);
      const t = await availabilityTable(domains);
      const avail = t.rows.filter(r => r.status === "available" || r.status === "likely-available");
      md += `${avail.length} of ${t.rows.length} checked domains look available.\n\n` + t.md;
      md += `\n\nName methods: ${names.map(n => `${n.name} (${n.method})`).join(", ")}.`;
      return { names, results: t.rows, markdown: md };
    }));

  server.registerTool("check_availability", { title: "Check domain availability + price", annotations: ro,
    description: "Live availability for specific domains via registry RDAP (IANA bootstrap) with WHOIS fallback, plus first-year and renewal list price where a verified public source has it. Pass full domains, or a name plus tlds.",
    inputSchema: { domains: z.array(z.string().min(3).max(253)).max(40).optional(), name: z.string().regex(/^[a-z0-9-]{1,63}$/i).optional(), tlds: tldList } },
    run(async a => {
      const list = [...(a.domains ?? []), ...(a.name ? (a.tlds ?? DEFAULT_TLDS).map((t: string) => `${a.name}.${t}`) : [])].map(D.normaliseDomain);
      if (!list.length) throw new Error("Provide `domains`, or `name` (with optional `tlds`).");
      const t = await availabilityTable([...new Set(list)].slice(0, 40));
      return { results: t.rows, markdown: `## Domain availability\n\n${t.md}` };
    }));

  server.registerTool("tld_pricing", { title: "TLD price list", annotations: ro,
    description: "Registration, renewal and transfer list prices (USD) per TLD from Porkbun's public pricing API, with source and timestamp. Unknown TLDs are reported as not found, never estimated.",
    inputSchema: { tlds: z.array(z.string()).min(1).max(40) } },
    run(async a => {
      const tl = a.tlds.map((t: string) => t.toLowerCase().replace(/^\./, ""));
      const p = await D.tldPrices(tl);
      let md = `## TLD prices\n\n| TLD | Register | Renew | Transfer |\n|---|---:|---:|---:|\n`;
      for (const t of tl) { const x = p.prices[t]; md += x ? `| .${t} | ${money(x.registration)} | ${money(x.renewal)} | ${money(x.transfer)} |\n` : `| .${t} | not offered by this source | | |\n`; }
      return { ...p, markdown: md + "\n" + PRICE_NOTE(p.fetchedAt) };
    }));

  server.registerTool("domain_lookup", { title: "RDAP/WHOIS lookup", annotations: ro,
    description: "Registration details for any domain: registrar, created/expiry dates, status codes, nameservers, and an expiry/drop signal (redemption, pending delete). For registered names, adds links to real aftermarket marketplaces to check manually.",
    inputSchema: { domain: z.string().min(3).max(253), includeRawWhois: z.boolean().optional() } },
    run(async a => {
      const d = D.normaliseDomain(a.domain);
      let info: any = null; let method = "RDAP"; let src = ""; let raw = "";
      try { const r = await D.rdapLookup(d); if (r.availability.status !== "unknown") { info = r; src = r.availability.source; } } catch { /* fallback */ }
      if (!info) { const w = await D.whoisLookup(d); method = "WHOIS"; src = `whois://${w.server}`; raw = w.raw; info = { availability: { domain: d, status: w.parsed.available ? "available" : "registered", expires: w.parsed.expires, registrar: w.parsed.registrar, statuses: w.parsed.statuses, dropSignal: D.dropSignal(w.parsed.statuses, w.parsed.expires) } }; }
      const av = info.availability; const r = info.raw;
      const ev = (k: string) => r?.events?.find((e: any) => e.eventAction === k)?.eventDate;
      const ns = r?.nameservers?.map((n: any) => n.ldhName?.toLowerCase()) ?? [];
      let md = `## ${d}\n\n**${av.status === "available" ? "Not registered (available)" : "Registered"}** (via ${method})\n\n`;
      if (av.status === "registered") {
        md += `- Registrar: ${av.registrar ?? "-"}\n- Created: ${ev("registration")?.slice(0, 10) ?? "-"}\n- Expires: ${av.expires?.slice(0, 10) ?? "-"}\n- Last changed: ${ev("last changed")?.slice(0, 10) ?? "-"}\n- Status: ${(av.statuses ?? []).join(", ") || "-"}\n- Nameservers: ${ns.join(", ") || "-"}\n`;
        md += av.dropSignal ? `- ⏳ **${av.dropSignal}**\n` : `- No expiry/drop signal (not expiring within 30 days).\n`;
        md += `\n**Aftermarket (links only; check manually, no listing data fetched):**\n` + D.aftermarketLinks(d).map(l => `- [${l.name}](${l.url})`).join("\n") + "\n";
      }
      md += `\n_Source: ${src}, checked ${new Date().toISOString()}._`;
      if (a.includeRawWhois && raw) md += `\n\n\`\`\`\n${raw.slice(0, 4000)}\n\`\`\``;
      return { domain: d, method, ...av, nameservers: ns, created: ev("registration"), aftermarket: av.status === "registered" ? D.aftermarketLinks(d) : [], source: src, markdown: md };
    }));

  server.registerTool("dns_lookup", { title: "DNS records", annotations: ro,
    description: "DNS records for any domain (A, AAAA, MX, NS, TXT, CNAME, CAA, SOA) via Cloudflare DNS-over-HTTPS, with TTLs and a quick email-auth (SPF/DMARC) check.",
    inputSchema: { domain: z.string().min(3).max(253), types: z.array(z.enum(["A", "AAAA", "MX", "NS", "TXT", "CNAME", "CAA", "SOA"])).optional() } },
    run(async a => {
      const types = a.types ?? ["A", "AAAA", "MX", "NS", "TXT", "CAA"];
      const r = await D.dnsLookup(a.domain, types);
      let dmarc: string | null = null;
      try { const dm = await D.dnsLookup(`_dmarc.${r.domain}`, ["TXT"]); dmarc = dm.records.TXT.map(x => x.data).find(x => /v=DMARC1/i.test(x)) ?? null; } catch { /* optional */ }
      const spf = (r.records.TXT ?? []).map(x => x.data).find(x => /v=spf1/i.test(x)) ?? null;
      let md = `## DNS for ${r.domain}\n\n| Type | Value | TTL |\n|---|---|---:|\n`;
      for (const t of types) { const all = r.records[t] ?? []; const recs = all.slice(0, 15); md += recs.length ? (all.length > 15 ? [...recs, { data: `... ${all.length - 15} more (see JSON)`, ttl: "" as any }] : recs).map(x => `| ${t} | \`${x.data.replace(/\|/g, "\\|").slice(0, 200)}\` | ${x.ttl} |`).join("\n") + "\n" : `| ${t} | (none) | |\n`; }
      md += `\nEmail auth: SPF ${spf ? "✅" : "❌ missing"}, DMARC ${dmarc ? "✅" : "❌ missing"}.\n\n_Source: ${r.resolver}, fetched ${r.fetchedAt}._`;
      return { ...r, spf, dmarc, markdown: md };
    }));

  server.registerTool("ssl_certificate", { title: "SSL/TLS certificate", annotations: ro,
    description: "Fetch the live TLS certificate for a domain: issuer, validity dates, days left, SANs, whether it is trusted, and negotiated protocol.",
    inputSchema: { domain: z.string().min(3).max(253), port: z.number().int().min(1).max(65535).optional() } },
    run(async a => {
      const c = await D.sslCert(a.domain, a.port ?? 443);
      const md = `## TLS certificate for ${c.domain}\n\n- Trusted: ${c.trusted ? "✅ yes" : `❌ no (${c.trustError})`}\n- Subject: ${c.subject}\n- Issuer: ${c.issuer}\n- Valid: ${c.validFrom.slice(0, 10)} → ${c.validTo.slice(0, 10)} (**${c.daysLeft} days left**${c.daysLeft < 14 ? ", renew soon!" : ""})\n- Protocol: ${c.protocol}\n- SANs: ${c.altNames.slice(0, 10).join(", ")}${c.altNames.length > 10 ? ` (+${c.altNames.length - 10} more)` : ""}\n\n_Source: direct TLS handshake to ${c.domain}:${a.port ?? 443} at ${c.checkedAt}._`;
      return { ...c, markdown: md };
    }));

  server.registerTool("prepare_purchase_link", { title: "Prepare a registrar link (no purchase)",
    annotations: { readOnlyHint: true, openWorldHint: false },
    description: "Returns a registrar search/checkout link for a domain so the USER can buy it themselves. This tool never registers, pays or reserves anything. Only call with userConfirmed=true after the user has explicitly asked for a purchase link for this exact domain.",
    inputSchema: { domain: z.string().min(3).max(253), registrar: z.enum(["porkbun", "namecheap", "cloudflare"]).optional(), userConfirmed: z.boolean().describe("Must be true, and only after explicit user approval") } },
    run(async a => {
      if (a.userConfirmed !== true) throw new Error("Not prepared: ask the user to explicitly confirm they want a purchase link for this domain, then call again with userConfirmed=true.");
      const av = await D.checkAvailability(a.domain);
      const l = D.purchaseLink(a.domain, a.registrar ?? "porkbun");
      const md = `## Purchase link for ${l.domain}\n\nCurrent status: **${av.status}** (via ${av.method}, ${av.checkedAt}).\n\n👉 [Open ${l.registrar} to review and buy](${l.url})\n\nNothing has been purchased or reserved. You complete checkout yourself on the registrar's site; the final price is shown there.`;
      return { ...l, availability: av, purchased: false, markdown: md };
    }));
  return server;
}
