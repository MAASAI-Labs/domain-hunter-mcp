// Live smoke test: node scripts/smoke.mjs [url]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(process.argv[2] ?? "http://localhost:3000/mcp")));
console.log("tools:", (await client.listTools()).tools.map(t => t.name).join(", "));
const calls = [
  ["brainstorm_domains", { idea: "AI meal planner for busy parents", count: 6, tlds: ["com", "io", "ai"] }],
  ["check_availability", { domains: ["google.com", "zqxv-not-real-8841.com", "github.io", "zqxvnotreal8841.co", "zqxvnotreal8841.de", "nic.ng"] }],
  ["tld_pricing", { tlds: ["com", "ai", "io", "ng", "notatld"] }],
  ["domain_lookup", { domain: "x.ai" }],
  ["dns_lookup", { domain: "x.ai" }],
  ["ssl_certificate", { domain: "x.ai" }],
  ["prepare_purchase_link", { domain: "zqxv-not-real-8841.com", userConfirmed: false }],
  ["prepare_purchase_link", { domain: "zqxv-not-real-8841.com", userConfirmed: true }],
];
for (const [name, args] of calls) { const t = Date.now(); const r = await client.callTool({ name, arguments: args }); console.log(`\n===== ${name} (${Date.now() - t} ms)${r.isError ? " ERROR" : ""}\n${r.content[0].text}`); }
await client.close();
