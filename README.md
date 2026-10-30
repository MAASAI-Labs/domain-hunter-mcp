# Domain Hunter (MCP server)

**Live MCP URL (Streamable HTTP):** `https://domain-hunter-mcp.vercel.app/mcp`  
Health check: `https://domain-hunter-mcp.vercel.app/health`

Domain Hunter helps you find and research domain names. You give it an idea, and it brainstorms brandable names, checks **live availability** across TLDs, shows **verified list prices**, flags expiring or dropping names, and runs DNS, SSL and RDAP/WHOIS lookups on any domain.

**It never registers or buys anything.** The most it can do is prepare a registrar link, and only after the user explicitly confirms. The user completes checkout themselves.

## Use in Cursor

**From the Cursor Marketplace:** once listed, install it from https://cursor.com/marketplace (publisher MAASAI Labs). The plugin manifest lives in https://github.com/MAASAI-Labs/cursor-plugins.

1. Search the Marketplace for this plugin and click **Install**.
2. Check the server is enabled under Cursor Settings, then MCP. Plugin servers show with a `plugin-` prefix.

**Manually:** add the hosted server to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "domain-hunter": { "url": "https://domain-hunter-mcp.vercel.app/mcp" }
  }
}
```


## Tools

| Tool | What it does |
|---|---|
| `brainstorm_domains` | Name ideas from a product idea (compounds, portmanteaus, prefixes/suffixes, vowel drops), ranked by length and pronounceability. Checks availability and price across TLDs (default .com, .io, .ai) |
| `check_availability` | Live status for specific domains, or one name across TLDs, with first-year and renewal price |
| `tld_pricing` | Register, renew and transfer prices per TLD. TLDs the source doesn't sell are reported as "not offered", never estimated |
| `domain_lookup` | Registrar, creation and expiry dates, status codes, nameservers, and an expiry/drop signal (expiring soon, grace period, redemption, pending delete). Registered names also get aftermarket marketplace links |
| `dns_lookup` | A, AAAA, MX, NS, TXT, CNAME, CAA and SOA records, plus an SPF/DMARC check |
| `ssl_certificate` | The live TLS certificate: issuer, validity, days left, SANs, whether it's trusted, and the protocol |
| `prepare_purchase_link` | A Porkbun, Namecheap or Cloudflare search link. Requires `userConfirmed: true`. Purchases nothing |

## Data sources (nothing fabricated)

- **Availability**:
  - Each registry's RDAP server, found through the [IANA RDAP bootstrap](https://data.iana.org/rdap/dns.json). A 404 means not registered; a record means registered.
  - If a TLD has no RDAP (for example .io, .co, .de, .me), it falls back to **WHOIS** (TCP 43, server found via whois.iana.org).
  - If WHOIS is unreachable, it falls back to **DNS**. Nameservers mean registered. NXDOMAIN shows as "🟡 likely available" with a warning.
  - Premium or reserved names can still fail at checkout, and the output says so.
- **Prices**: [Porkbun's public pricing endpoint](https://porkbun.com/api/json/v3/documentation) (`POST /api/json/v3/pricing/get`, no key needed). These are USD list prices, cached for 6 h and labelled with source and timestamp. If the endpoint fails, no prices are shown rather than guessed.
- **Expiring names**: real RDAP/WHOIS status and expiry dates only.
- **Aftermarket**: links to Afternic, Sedo, GoDaddy and ExpiredDomains.net search pages, labelled "links only". The server doesn't scrape or invent listing prices.
- **DNS**: Cloudflare DNS-over-HTTPS. **SSL**: a direct TLS handshake.

## Example prompts

- "Find me a brandable .com or .ai for an AI meal planner for busy parents."
- "Is mealmate available on .com, .io, .ai or .app? How much would each cost?"
- "Who owns stripe.com, and when does it expire?"
- "Check the DNS and SSL certificate for x.ai. Is email authentication set up?"
- "This name is taken. Is it expiring, or listed for sale anywhere?"

Tip: Grok can also come up with its own creative names and pass them to `check_availability`. The built-in brainstormer is deterministic and works best as a starting point.

## Run locally

```bash
npm install && npm test && npm run build
npm start              # http://localhost:3000/mcp
npm run start:stdio
npm run smoke          # live calls to every tool
```

## Deploy to Vercel

1. Push to GitHub and import it at vercel.com/new (preset: Other). No environment variables are needed.
2. The MCP URL is `https://<project>.vercel.app/mcp`. Check it with `node scripts/smoke.mjs <url>`.

Vercel functions can make outbound TCP connections, which `ssl_certificate` and WHOIS need. If port 43 is blocked in your environment, the DNS fallback takes over automatically.

## Testing instructions for marketplace reviewers

No credentials needed.

1. List tools. You should see 7, and none of them register or buy.
2. `brainstorm_domains` with `{"idea": "AI meal planner for busy parents", "count": 6}`: a table of names × TLDs with ✅/❌, prices and a source line.
3. `check_availability` with `{"domains": ["google.com", "zqxv-not-real-8841.com"]}`: google.com is ❌ registered, and the other is ✅ available at the Porkbun .com price.
4. `domain_lookup` with `{"domain": "x.ai"}`, `dns_lookup` with `{"domain": "x.ai"}`, and `ssl_certificate` with `{"domain": "x.ai"}`.
5. `prepare_purchase_link` with `userConfirmed: false` returns an error asking for confirmation. With `true`, it returns a link and the line "Nothing has been purchased".

## Privacy and terms

- Privacy policy: https://maasai.tech/privacy
- Terms of use: https://maasai.tech/terms
- Support and data requests: colepresley000@gmail.com

## License

MIT
