interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * Written as a sentence rather than a sigil because it is going to be read by
 * whoever gets the error, and "our own service, not a third party" is the
 * single most useful thing to tell them — fetchWithTimeout's own comment
 * (fleet #1047) is about exactly this ambiguity, where blaming a healthy vendor
 * by name sent the next person waiting for an outage that did not exist.
 */
const INTERNAL_ORIGIN_MARKER = ' [pipeworx-hosted origin — our own service, not a third party]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}
/**
 * FINRA Fixed Income aggregate market data (fleet #530).
 *
 * US bond market activity as FINRA publishes it in aggregate: Treasury trading
 * volumes, corporate and agency debt market breadth and sentiment, and
 * securitized-product pricing and activity.
 *
 * ZERO-RATED, AND THAT IS A LICENCE CONDITION, NOT A PRICING CHOICE.
 * FINRA's Specific Terms for Fixed Income Data §2.3 permit redistribution only
 * where "there is no additional or incremental fee charged for the Fixed Income
 * Data". So every tool here is metered at 0 credits AND the gateway pack entry
 * carries `zeroRated: true`. Both halves are required and neither substitutes
 * for the other: under pricing-v2 a 0-credit call is still an ANCHORED REQUEST
 * that advances the caller's monthly bracket, so the meter alone still lets
 * calling this pack change what their next call costs. A billed version of this
 * pack would breach the licence — do not add a meter, and do not drop the flag.
 *
 * SCOPE IS THE AGGREGATE TIER ONLY. The TRACE transaction tape is excluded by
 * §8 of the same terms and is priced separately under FINRA Rule 7730 with a
 * mandated reporting delay. Nothing here returns transaction-level data, and
 * widening it to that would need a paid vendor agreement.
 *
 * Attribution is required by the licence and is returned on every response.
 *
 * Auth: OAuth2 client_credentials. _apiKey = "<clientId>:<clientSecret>",
 * matching the convention in epo-ops / euipo. Token cached per client id.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'FINRA Fixed Income aggregate market data');
}

// ews.FIP.finra.org, not ews.finra.org. The latter is the credential
// self-service host (password reset) and answers the token path with a bare
// HTTP 500 and an empty body — no hint that the host is simply wrong.
const TOKEN_URL = 'https://ews.fip.finra.org/fip/rest/ews/oauth2/access_token?grant_type=client_credentials';
const API_URL = 'https://api.finra.org/data/group/FixedIncomeMarket/name';
const PARTITIONS_URL = 'https://api.finra.org/partitions/group/FixedIncomeMarket/name';

/** Required by FINRA's Specific Terms for Fixed Income Data §2.3. */
const ATTRIBUTION =
  'Source: FINRA. Fixed Income aggregate data provided by FINRA under its Specific Terms for Fixed Income Data. Redistributed at no incremental fee. Not for further redistribution.';

/**
 * Dataset keys -> FINRA's ACTUAL dataset names, and the date field each one is
 * filtered on.
 *
 * NAMES. These are not the labels on FINRA's fee/catalog pages. "Corporate Debt
 * Market Sentiment" on the catalog is `corporateMarketSentiment` on the API, and
 * requesting the label spelling returns 404 "Unable to find the specified
 * dataset". The reliable source is the docs' own mock names — every dataset
 * ships an `<name>Mock` twin, so stripping "Mock" gives the production name.
 * To check one without a credential, `GET
 * https://api.finra.org/metadata/group/FixedIncomeMarket/name/<name>` is a
 * keyless oracle: 404 means no such dataset, 200 means it exists and publishes
 * field metadata, 400 means it exists but publishes none.
 *
 * DATE FIELDS. There is no common one. `tradeDate`, `tradeReportDate`,
 * `reportDate`, `beginningOfWeekDate` and `beginningOfTheMonthDate` are all in
 * use across this group, and filtering on the wrong one is a hard 400 ("The
 * following fields are not available in this dataset") — which is why every
 * entry carries its own instead of the pack assuming one.
 */
const DATASETS: Record<string, { name: string; dateField: string; what: string }> = {
  treasury_daily: { name: 'treasuryDailyAggregates', dateField: 'tradeDate', what: 'Daily US Treasury trading aggregates by product category' },
  // treasury_weekly (treasuryWeeklyAggregates) is deliberately absent. The name
  // resolves and the dataset publishes field metadata, but it returns zero rows
  // on our credential at EVERY window tried, including 2021-01..2021-03, which
  // is the range FINRA's own docs use as the worked example. An advertised key
  // that can never return data is a dead option in the menu — the same failure
  // this pack was just repaired for. Re-add it if it ever starts answering.
  treasury_monthly: { name: 'treasuryMonthlyAggregates', dateField: 'beginningOfTheMonthDate', what: 'Monthly US Treasury trading aggregates' },
  corporate_breadth: { name: 'corporateMarketBreadth', dateField: 'tradeReportDate', what: 'Corporate debt market breadth — advancing vs declining issues' },
  corporate_sentiment: { name: 'corporateMarketSentiment', dateField: 'tradeReportDate', what: 'Corporate debt market sentiment — customer buy vs sell activity' },
  corporate_144a_breadth: { name: 'corporate144AMarketBreadth', dateField: 'tradeReportDate', what: 'Corporate 144A debt market breadth' },
  corporate_144a_sentiment: { name: 'corporate144AMarketSentiment', dateField: 'tradeReportDate', what: 'Corporate 144A debt market sentiment' },
  agency_breadth: { name: 'agencyMarketBreadth', dateField: 'tradeReportDate', what: 'Agency debt market breadth' },
  agency_sentiment: { name: 'agencyMarketSentiment', dateField: 'tradeReportDate', what: 'Agency debt market sentiment' },
  agency_mbs_activity: { name: 'agencyMbsTradingActivity', dateField: 'reportDate', what: 'Agency MBS trading activity' },
  agency_mbs_pricing: { name: 'agencyMbsPricing', dateField: 'reportDate', what: 'Agency pass-thru specified pool MBS pricing' },
  agency_tba_pricing: { name: 'agencyTbaPricing', dateField: 'reportDate', what: 'Agency pass-thru TBA pricing' },
  agency_arm_pricing: { name: 'agencyMbsArmHybridPricing', dateField: 'reportDate', what: 'Agency pass-thru ARM and hybrid MBS pricing' },
  agency_cmo_pricing: { name: 'agencyCmoPricing', dateField: 'reportDate', what: 'Agency CMO pricing by deal vintage' },
  non_agency_cmo_vintage: { name: 'nonAgencyCmoVintagePricing', dateField: 'reportDate', what: 'Non-agency CMO pricing by deal vintage' },
  non_agency_cmo_abs: { name: 'nonAgencyCmoAbsPricing', dateField: 'reportDate', what: 'Non-agency CMO and ABS pricing by product' },
  cdo_pricing: { name: 'collateralizedObligationPricing', dateField: 'reportDate', what: 'CBO / CDO / CLO pricing' },
  cmbs_daily: { name: 'dailyCmbsPricing', dateField: 'reportDate', what: 'Daily CMBS pricing by deal vintage' },
  cmbs_weekly: { name: 'weeklyCmbsPricing', dateField: 'reportDate', what: 'Weekly CMBS pricing by deal vintage' },
  securitized_activity: { name: 'securitizedProductTradingActivity', dateField: 'reportDate', what: 'Securitized products trading activity (non-agency and CMBS)' },
  capped_volume_corporate: { name: 'corporatesAndAgenciesCappedVolume', dateField: 'tradeReportDate', what: 'Corporate and agency capped volume' },
  capped_volume_securitized: { name: 'securitizedProductsCappedVolume', dateField: 'tradeReportDate', what: 'Securitized product capped volume' },
};

const tools: McpToolExport['tools'] = [
  {
    name: 'finra_fixed_income_datasets',
    description:
      'List the FINRA fixed income aggregate datasets available here — US Treasury trading aggregates (daily, weekly, monthly), corporate and agency debt market breadth and sentiment, corporate 144A breadth and sentiment, agency MBS and securitized product trading activity, TBA and CMO and CMBS and CBO/CDO/CLO pricing, and capped volume series — with the key to pass to the other tools, what each series measures, and the date field it is filtered on. Call this first to see what US bond-market data can be queried. Covers AGGREGATE market statistics published by FINRA, not individual bond transactions. Example: finra_fixed_income_datasets({}). Keyless for the caller.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'finra_fixed_income_series',
    description:
      'Get a FINRA fixed income aggregate series — US bond market trading activity as reported to FINRA. Answers "how much Treasury volume traded", "corporate bond market sentiment", "agency MBS trading activity", "is bond market breadth positive", "what is CMBS pricing by deal vintage". Pass a dataset key from finra_fixed_income_datasets (e.g. "treasury_daily", "corporate_sentiment", "agency_mbs_activity", "capped_volume_corporate") and optionally a date range. With no date range, returns FINRA\'s latest published period for that series; with start_date or end_date, returns that window. This is MARKET-WIDE aggregate data, not individual trades — FINRA licenses transaction-level TRACE data separately and it is not available here. Example: finra_fixed_income_series({ dataset: "treasury_daily", limit: 10 }); finra_fixed_income_series({ dataset: "corporate_sentiment", start_date: "2026-07-01" }).',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', description: 'Dataset key from finra_fixed_income_datasets, e.g. "treasury_daily"', enum: Object.keys(DATASETS) },
        start_date: { type: 'string', description: 'Earliest date, YYYY-MM-DD (optional)' },
        end_date: { type: 'string', description: 'Latest date, YYYY-MM-DD (optional)' },
        limit: { type: 'number', description: 'Max rows (default 25, max 500)' },
      },
      required: ['dataset'],
    },
  },
];

const clamp = (n: unknown, d: number, max: number) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), max) : d;
};

const TOKEN_CACHE = new Map<string, { token: string; expires: number }>();

async function accessToken(apiKey: string): Promise<string> {
  const idx = apiKey.indexOf(':');
  if (idx <= 0) {
    throw new Error(
      'FINRA requires an API key in the form "<clientId>:<clientSecret>" — the key in use has no ":" separator. Pass your Client ID and Client Secret joined by a colon as the _apiKey argument.',
    );
  }
  const id = apiKey.slice(0, idx);
  const cached = TOKEN_CACHE.get(id);
  if (cached && cached.expires > Date.now() + 30_000) return cached.token;

  const res = await pwFetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(apiKey)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    if (res.status === 401) {
      throw new Error(
        `FINRA: auth failed (401) exchanging the client credential for a token. The Client ID or Client Secret is wrong, or the credential was never activated — a FINRA credential is inert until its secret is set via the activation email. Detail: ${body}`,
      );
    }
    throw new Error(`FINRA OAuth ${res.status}: ${body}`);
  }
  // The `query()` path below already guards its empty body; this one did not,
  // and it is the one that fires FIRST on every call. FINRA's token endpoint
  // answers 200-with-nothing when the credential is inert, so `res.json()` threw
  // `Unexpected end of JSON input` and the caller asking for bond-market
  // aggregates was handed our parser's internal state, booked as class `error`
  // — a Pipeworx defect — for what is an upstream credential problem (fleet #1023).
  const raw = await res.text();
  if (!raw.trim()) {
    throw new Error(
      'auth_required: FINRA returned an EMPTY body (HTTP ' +
        res.status +
        ') from the OAuth token exchange instead of a token. That is what an inert credential looks like — ' +
        'a FINRA Client ID/Secret stays unusable until the secret is set from the activation email. ' +
        'Pass an activated credential as _apiKey in "clientId:clientSecret" form.',
    );
  }
  let data: { access_token?: string; expires_in?: number };
  try {
    data = JSON.parse(raw) as { access_token?: string; expires_in?: number };
  } catch {
    throw new Error(
      `upstream_down: FINRA answered the OAuth token exchange with HTTP ${res.status} and a body that is not JSON. It begins: ${raw.slice(0, 120)}`,
    );
  }
  if (!data.access_token) throw new Error('FINRA OAuth: response carried no access_token');
  const ttl = (Number(data.expires_in) || 1800) * 1000;
  TOKEN_CACHE.set(id, { token: data.access_token, expires: Date.now() + ttl });
  return data.access_token;
}

async function query(apiKey: string, dataset: string, body: Record<string, unknown>) {
  const token = await accessToken(apiKey);
  const res = await pwFetch(`${API_URL}/${dataset}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = (await res.text()).slice(0, 300);
    if (res.status === 403) {
      throw new Error(
        `FINRA: the credential is not entitled to dataset "${dataset}" (403). Fixed Income aggregates require a Public credential or better on an account with the Fixed Income terms accepted. Detail: ${t}`,
      );
    }
    const err = new Error(`FINRA ${dataset} error ${res.status}: ${t}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  // A dataset with nothing to return answers 200 with a COMPLETELY EMPTY body,
  // not "[]" — res.json() on that throws "Unexpected end of JSON input", which
  // surfaces to the caller as a parse bug in us rather than as "no rows".
  // treasuryWeeklyAggregates does this on an unfiltered request.
  const text = await res.text();
  if (!text.trim()) return [];
  return JSON.parse(text);
}

/**
 * The newest partition value for a dataset, or null.
 *
 * Why this exists: FINRA's default row order is ascending, and `sortFields` is
 * NOT a way around that here — the platform restricts it to requests that also
 * carry a compareFilter of type EQUAL on every partition field, and for these
 * datasets the partition field IS the date. So "give me the latest reading"
 * cannot be expressed as a sort at all. It has to be expressed as an equality
 * filter on a date you already know, and this endpoint is how you know it.
 *
 * Without this the pack answers "how is the corporate bond market trading" with
 * rows from 2023 and looks entirely successful doing it.
 *
 * Skipped when a dataset has more than one partition field: the newest date
 * would then span several partition tuples and picking one would silently drop
 * the others. Better to return FINRA's own order and say so.
 */
async function latestPartition(apiKey: string, dataset: string): Promise<{ field: string; value: string } | null> {
  const token = await accessToken(apiKey);
  const res = await pwFetch(`${PARTITIONS_URL}/${dataset}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) return null;
  const text = await res.text();
  if (!text.trim()) return null;
  const d = JSON.parse(text) as { partitionFields?: string[]; availablePartitions?: { partitions?: string[] }[] };
  if (!Array.isArray(d.partitionFields) || d.partitionFields.length !== 1) return null;
  const values = (d.availablePartitions ?? [])
    .map((p) => (Array.isArray(p.partitions) ? p.partitions[0] : undefined))
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (!values.length) return null;
  // Lexicographic max is chronological max for yyyy-MM-dd, which is the format
  // every partition value in this group uses.
  return { field: d.partitionFields[0], value: values.reduce((a, b) => (b > a ? b : a)) };
}

async function listDatasets() {
  return {
    source: 'FINRA Fixed Income aggregate datasets',
    attribution: ATTRIBUTION,
    scope:
      'Aggregate market statistics only. FINRA licenses transaction-level TRACE data separately under Rule 7730 with a mandated reporting delay; it is not available through this pack.',
    pricing:
      "Zero-rated. FINRA's licence forbids charging any incremental fee for this data, so every call here costs 0 credits on every tier and does not count toward volume pricing.",
    count: Object.keys(DATASETS).length,
    datasets: Object.entries(DATASETS).map(([key, d]) => ({ key, series: d.name, measures: d.what, date_field: d.dateField })),
  };
}

async function series(apiKey: string, a: Record<string, unknown>) {
  const key = String(a.dataset ?? '').trim();
  const ds = DATASETS[key];
  if (!ds) {
    return {
      found: false,
      reason: 'unknown_dataset',
      requested: key || null,
      hint: `"${key}" is not a dataset key here. Call finra_fixed_income_datasets({}) for the ${Object.keys(DATASETS).length} available keys.`,
      available: Object.keys(DATASETS),
      attribution: ATTRIBUTION,
    };
  }
  const limit = clamp(a.limit, 25, 500);

  // Every dataset filters on its OWN date field — see the DATASETS note. The
  // pack used to send `reportDate` for all of them, which meant any call with a
  // date range 400'd on the datasets that call it something else.
  const body: Record<string, unknown> = { limit };
  if (a.start_date || a.end_date) {
    body.dateRangeFilters = [{
      fieldName: ds.dateField,
      startDate: String(a.start_date ?? '1990-01-01'),
      endDate: String(a.end_date ?? '2099-12-31'),
    }];
  }

  // With no date range asked for, an agent wants the CURRENT reading, and
  // FINRA's ascending default would hand it the oldest rows on file instead.
  // See latestPartition() for why this is an equality filter and not a sort.
  // Any failure here is non-fatal: we fall back to the plain request and say in
  // `order` that these are the oldest rows, rather than passing them off as
  // current.
  let pinned: { field: string; value: string } | null = null;
  let recentWindow: string | null = null;
  if (!a.start_date && !a.end_date) {
    try {
      pinned = await latestPartition(apiKey, ds.name);
    } catch {
      pinned = null;
    }
    if (pinned) {
      body.compareFilters = [{ fieldName: pinned.field, fieldValue: pinned.value, compareType: 'EQUAL' }];
    } else {
      // The pricing datasets publish no metadata and resolve no partitions, so
      // there is nothing to pin to — but they are current (2026 rows exist),
      // and unbounded they hand back 2016. A trailing window gets the caller
      // recent data; if it turns out to be empty we drop it below rather than
      // reporting a live series as having no data.
      const since = new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10);
      recentWindow = since;
      body.dateRangeFilters = [{ fieldName: ds.dateField, startDate: since, endDate: '2099-12-31' }];
    }
  }

  let rows = await query(apiKey, ds.name, body);
  if (recentWindow && (!Array.isArray(rows) || !rows.length)) {
    // Nothing in the trailing window. The series may simply publish on a longer
    // lag than 180 days, so ask again unbounded rather than calling it empty.
    delete body.dateRangeFilters;
    recentWindow = null;
    rows = await query(apiKey, ds.name, body);
  }
  const list = Array.isArray(rows) ? rows : [];

  if (!list.length) {
    return {
      found: false,
      reason: 'no_rows_in_range',
      dataset: key,
      series: ds.name,
      measures: ds.what,
      window: { start: a.start_date ?? null, end: a.end_date ?? null },
      hint: 'FINRA returned no rows for this window. These are published on a reporting lag, so a very recent range is often genuinely empty rather than wrong — widen the dates.',
      attribution: ATTRIBUTION,
    };
  }

  return {
    dataset: key,
    series: ds.name,
    measures: ds.what,
    count: list.length,
    date_field: ds.dateField,
    order: pinned
      ? `latest available ${pinned.field} — every row is ${pinned.value}, FINRA's most recent published period for this series`
      : recentWindow
        ? `${ds.dateField} ascending, bounded to on or after ${recentWindow} — this series publishes no partitions to pin to, so the window is a trailing default rather than FINRA's latest period`
        : a.start_date || a.end_date
          ? `${ds.dateField} ascending within the requested window — FINRA's own order`
          : `${ds.dateField} ascending, unbounded — no partitions to pin to and nothing in the trailing window, so these are the OLDEST rows on file, not the newest. Pass start_date to bound the window yourself.`,
    scope: 'FINRA aggregate market data — not individual bond transactions.',
    attribution: ATTRIBUTION,
    rows: list,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === 'finra_fixed_income_datasets') return listDatasets();

  const apiKey = args._apiKey as string;
  delete args._apiKey;
  if (!apiKey) {
    throw new Error(
      'FINRA fixed income requires an API key. Pass your own FINRA Client ID and Secret as "<clientId>:<clientSecret>" via _apiKey — a free Public credential from developer.finra.org is sufficient.',
    );
  }

  switch (name) {
    case 'finra_fixed_income_series': return series(apiKey, args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// credits: 0 is a LICENCE REQUIREMENT (Specific Terms for Fixed Income Data
// §2.3 — no additional or incremental fee). Do not meter this pack. The gateway
// pack entry must ALSO carry zeroRated: true — see the header for why the meter
// alone is not enough.
export default { tools, callTool, meter: { credits: 0 } } satisfies McpToolExport;
