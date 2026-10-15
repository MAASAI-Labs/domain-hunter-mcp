import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as D from "../src/domain";
import { clearCache } from "../src/cache";
import { createServer } from "../src/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const bootstrap = { services: [[["com", "net"], ["https://rdap.verisign.com/com/v1/"]], [["ai"], ["https://rdap.example.ai/rdap/"]]] };
const registered = { status: ["client transfer prohibited", "redemption period"], events: [{ eventAction: "registration", eventDate: "2010-01-01T00:00:00Z" }, { eventAction: "expiration", eventDate: "2026-10-01T00:00:00Z" }],
  entities: [{ roles: ["registrar"], vcardArray: ["vcard", [["fn", {}, "text", "Example Registrar, Inc."]]] }], nameservers: [{ ldhName: "NS1.EXAMPLE.COM" }] };
const pricing = { status: "SUCCESS", pricing: { com: { registration: "11.08", renewal: "11.08", transfer: "11.08", coupons: [] }, ai: { registration: "82.70", renewal: "82.70", transfer: "165.09", coupons: [] } } };
let spy: any;
beforeEach(() => {
  clearCache();
  spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
    const u = String(input);
    if (u === D.IANA_BOOTSTRAP) return new Response(JSON.stringify(bootstrap));
    if (u === D.PORKBUN_PRICING) return new Response(JSON.stringify(pricing));
    if (u.endsWith("/domain/taken.com")) return new Response(JSON.stringify(registered));
    if (u.includes("/domain/")) return new Response("", { status: 404 });
    return new Response("", { status: 500 });
  });
});
afterEach(() => spy.mockRestore());

describe("validation & brainstorming", () => {
  it("normalises URLs and rejects junk", () => {
    expect(D.normaliseDomain("https://Example.COM/path")).toBe("example.com");
    expect(() => D.normaliseDomain("not a domain")).toThrow(/not a valid domain/);
    expect(() => D.normaliseDomain("-bad.com")).toThrow();
  });
  it("brainstorm is deterministic, ranked, diverse and rejects empty ideas", () => {
    const a = D.brainstorm("AI meal planner for busy parents", 12);
    expect(a).toEqual(D.brainstorm("AI meal planner for busy parents", 12));
    expect(a).toHaveLength(12);
    expect(a.every((x, i) => i === 0 || a[i - 1].score >= x.score)).toBe(true);
    expect(new Set(a.map(x => x.name)).size).toBe(12);
    expect(() => D.brainstorm("the a of", 5)).toThrow(/meaningful word/);
  });
  it("pronounceability penalises consonant clusters", () => {
    expect(D.pronounceability("mealio")).toBeGreaterThan(D.pronounceability("xkcdptr"));
  });
});

describe("RDAP, WHOIS parsing, drop signals", () => {
  it("404 from registry RDAP = available; 200 = registered with expiry, registrar and drop signal", async () => {
    const free = await D.checkAvailability("brandnewname123.com");
    expect(free).toMatchObject({ status: "available", method: "RDAP" });
    expect(free.source).toBe("https://rdap.verisign.com/com/v1/domain/brandnewname123.com");
    const taken = await D.checkAvailability("taken.com");
    expect(taken).toMatchObject({ status: "registered", registrar: "Example Registrar, Inc.", expires: "2026-10-01T00:00:00Z" });
    expect(taken.dropSignal).toMatch(/redemption/i);
  });
  it("dropSignal reads pending delete and near expiry", () => {
    expect(D.dropSignal(["pending delete"])).toMatch(/Pending delete/);
    expect(D.dropSignal([], new Date(Date.now() + 10 * 86400_000).toISOString())).toMatch(/Expires in (9|10) days/);
    expect(D.dropSignal([], new Date(Date.now() + 400 * 86400_000).toISOString())).toBeUndefined();
  });
  it("parses WHOIS free and registered responses", () => {
    expect(D.parseWhois("Domain Status: free\n").available).toBe(true);
    expect(D.parseWhois("NOT FOUND\n>>> Last update of WHOIS database").available).toBe(true);
    const r = D.parseWhois("Domain Name: EXAMPLE.IO\nRegistrar: Foo Ltd\nRegistry Expiry Date: 2027-05-01T00:00:00Z\nDomain Status: clientTransferProhibited\n");
    expect(r).toMatchObject({ available: false, registrar: "Foo Ltd", expires: "2027-05-01T00:00:00Z", statuses: ["clientTransferProhibited"] });
  });
});

describe("pricing", () => {
  it("returns verified prices and null (not a guess) for unknown TLDs", async () => {
    const p = await D.tldPrices(["com", "ai", "zzz"]);
    expect(p.prices.com).toMatchObject({ registration: 11.08, registrar: "Porkbun", currency: "USD" });
    expect(p.prices.zzz).toBeNull();
  });
});

describe("MCP tools", () => {
  async function client() {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer().connect(a); const c = new Client({ name: "t", version: "1" }); await c.connect(b); return c;
  }
  it("lists 7 tools, none of which purchase", async () => {
    const c = await client(); const { tools } = await c.listTools();
    expect(tools.map(t => t.name)).toEqual(["brainstorm_domains", "check_availability", "tld_pricing", "domain_lookup", "dns_lookup", "ssl_certificate", "prepare_purchase_link"]);
    expect(tools.some(t => /^(register|buy|purchase)_/.test(t.name))).toBe(false);
  });
  it("prepare_purchase_link refuses without explicit confirmation and never purchases", async () => {
    const c = await client();
    const no = await c.callTool({ name: "prepare_purchase_link", arguments: { domain: "brandnewname123.com", userConfirmed: false } });
    expect(no.isError).toBe(true);
    const yes: any = await c.callTool({ name: "prepare_purchase_link", arguments: { domain: "brandnewname123.com", userConfirmed: true } });
    expect(yes.content[0].text).toContain("https://porkbun.com/checkout/search?q=brandnewname123.com");
    expect(yes.content[0].text).toMatch(/Nothing has been purchased/);
  });
  it("check_availability table shows price only for available names, with sources", async () => {
    const c = await client();
    const r: any = await c.callTool({ name: "check_availability", arguments: { domains: ["taken.com", "brandnewname123.com"] } });
    const t = r.content[0].text as string;
    expect(t).toMatch(/brandnewname123\.com \| ✅ available \| \$11\.08/);
    expect(t).toMatch(/taken\.com \| ❌ registered \| - \|/);
    expect(t).toMatch(/Porkbun public pricing API/);
  });
});
