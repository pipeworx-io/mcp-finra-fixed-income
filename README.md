# @pipeworx/finra-fixed-income

FINRA fixed income MCP — US bond market activity in aggregate: Treasury trading
volumes, corporate and agency debt market breadth and sentiment, securitized
product pricing and trading activity, and capped-volume series. Platform key
(free FINRA Public credential); BYO supported.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## Tools

- `finra_fixed_income_datasets()` — list the 21 dataset keys, what each series
  measures, and the date field it filters on. Keyless.
- `finra_fixed_income_series({ dataset, start_date?, end_date?, limit? })` —
  fetch a series. With no date range it returns FINRA's latest published
  period; with `start_date`/`end_date` it returns that window.

## Scope

**Aggregate market statistics only.** This pack does not return individual bond
transactions. The TRACE transaction tape is a separate FINRA product, excluded
by §8 of the terms below and priced under
[FINRA Rule 7730](https://www.finra.org/rules-guidance/rulebooks/finra-rules/7730)
with a mandated six-to-eighteen-month reporting delay. It is not available here
and asking for it will not produce it.

## Pricing — zero-rated, by licence

Every call costs **0 credits on every tier**, and does not count toward
volume-pricing brackets. This is not a promotion and not a pricing decision.
FINRA's [Specific Terms for Fixed Income Data](https://developer.finra.org/specific-terms-fixed-income-data)
§2.3(b) permit redistribution only where "there is no additional or incremental
fee charged for the Fixed Income Data", so a billed version of this pack would
breach the licence. The pack sets `meter: { credits: 0 }` **and** the gateway
pack entry sets `zeroRated: true` — both are required, because under pricing-v2
even a 0-credit call is an anchored request that advances a customer's monthly
bracket and so changes what their *next* call costs.

Two other conditions of the same clause are met in the response and in our
published terms: **attribution** (every response carries an `attribution` field
naming FINRA as owner and source) and **no further redistribution** by callers
(<https://pipeworx.io/terms> §6). Callers may use this data for non-commercial
personal or professional use and may not redistribute it.

## Auth

Platform key on the gateway (`PLATFORM_FINRA_KEY`), or BYO.

OAuth2 `client_credentials`. The key is `"<clientId>:<clientSecret>"` — Client ID
and Client Secret joined by a colon, the same convention `epo-ops` and `euipo`
use. A free **Individual / Public** credential from
<https://developer.finra.org> carries the whole Fixed Income group at $0/month
per <https://developer.finra.org/fees>.

### Activation caveat

A FINRA credential is inert until activated: registration produces a FINRA
Gateway UserID, the API Terms of Service must be accepted in the API Console,
and the secret is set through an emailed link that **expires in 24 hours** (the
Client ID arrives in a separate email). An unactivated credential fails at the
token exchange with a 401, which reads like a wrong password rather than an
unfinished signup.

The signup itself is a human web flow — `developer.finra.org/create-account`
sits behind a JavaScript bot challenge and has no HTTP path.

## Known gap

`treasuryWeeklyAggregates` is **not** exposed. The name resolves and the
dataset publishes field metadata, but on our credential it returns zero rows at
every window tried — including 2021-01 to 2021-03, the range FINRA's own docs
use as the worked example for it. Rather than advertise a key that can never
answer, it is left out with a note in the source. Daily and monthly Treasury
aggregates both work.

## Gotchas

- **The token host is `ews.fip.finra.org`, not `ews.finra.org`.** The latter is
  the credential self-service host and answers the token path with a bare HTTP
  500 and an empty body, with nothing to suggest the host is simply wrong.
- **Dataset names are not derivable from the catalog page.** The anchor slugs on
  <https://developer.finra.org/catalog> (`corporate_debt_market_sentiment`) do
  not convert to API names by any rule: the real name is
  `corporateMarketSentiment` — "Debt" is dropped. Likewise "Securitized
  Products Trading Activity" is `securitizedProductTradingActivity` (singular
  "Product") and "Corporate And Agency Capped Volume" is
  `corporatesAndAgenciesCappedVolume` (both plural). The real names are listed
  in the request examples on <https://developer.finra.org/docs>. A wrong name
  returns a 404 that names the dataset back at you, so it reads as a missing
  dataset rather than a typo.
- **There is no group listing.** `GET /data/group/FixedIncomeMarket` and
  `GET /metadata/group/FixedIncomeMarket` are both 404. But
  `GET /metadata/group/FixedIncomeMarket/name/<dataset>` is **keyless** and
  works as a name oracle: 404 means no such dataset, 200 means it exists and
  publishes field metadata, 400 means it exists but publishes none.
- **Each dataset has its own date field** — `tradeDate`, `tradeReportDate`,
  `reportDate`, `beginningOfWeekDate` and `beginningOfTheMonthDate` are all in
  use, and there is no common one. Filtering on the wrong field is a hard 400
  ("The following fields are not available in this dataset"). Each entry in the
  pack's `DATASETS` map carries its own; `finra_fixed_income_datasets` reports
  it as `date_field`.
- **FINRA's default row order is ascending, and `sortFields` is not a way
  around it.** The platform restricts `sortFields` to requests that also carry a
  `compareFilters` entry of type `EQUAL` on every partition field — and for
  these datasets the partition field *is* the date, so "newest first" cannot be
  expressed as a sort at all. Left alone, the tool answers "how is the corporate
  bond market trading" with rows from 2023 and looks entirely successful doing
  it. The pack instead reads `GET /partitions/group/FixedIncomeMarket/name/<ds>`
  (credentialed), takes the newest partition value, and pins the query to it
  with an EQUAL filter. The pricing datasets (TBA, ARM/hybrid, specified pool,
  CMO, CMBS, CBO/CDO/CLO, securitized activity) publish neither metadata nor
  partitions, so there is nothing to pin to — those fall back to a trailing
  180-day window, which is enough to reach their current rows. The `order` field
  states which of the three paths the call actually took, including the case
  where none worked and the rows really are the oldest on file.
- **A dataset with nothing to return answers 200 with a completely empty body**,
  not `[]`. Parsing that as JSON throws "Unexpected end of JSON input", which
  reads as a bug in us rather than as "no rows" —
  `treasuryWeeklyAggregates` does exactly this on an unfiltered request.
- These series publish on a reporting lag, so a very recent date range can be
  genuinely empty rather than wrong.

## Data sources

- Token: `https://ews.fip.finra.org/fip/rest/ews/oauth2/access_token`
- Data: `https://api.finra.org/data/group/FixedIncomeMarket/name/<dataset>`
- Metadata (keyless): `https://api.finra.org/metadata/group/FixedIncomeMarket/name/<dataset>`
- Partitions (credentialed): `https://api.finra.org/partitions/group/FixedIncomeMarket/name/<dataset>`
- Catalog: <https://developer.finra.org/catalog>
- Licence: <https://developer.finra.org/specific-terms-fixed-income-data>

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "finra-fixed-income": {
      "url": "https://gateway.pipeworx.io/finra-fixed-income/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/finra-fixed-income/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/finra_fixed_income_datasets \
  -H 'Content-Type: application/json' \
  -d '{}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/finra_fixed_income_datasets`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "finra-fixed-income": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-finra-fixed-income"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-finra-fixed-income
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Finra Fixed Income data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
