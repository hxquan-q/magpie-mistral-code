// Mistral Vibe Code, as an OpenCode provider plugin (unofficial), served the
// way the official mistral-vibe CLI serves it:
//
// - Sign-in is the browser sign-in the CLI does: POST console.mistral.ai's
//   /api/vibe/sign-in with a PKCE challenge, the page it answers with is
//   opened, its poll_url is read until the browser has signed in, and
//   POST /api/vibe/sign-in/{process_id}/exchange (exchange_token +
//   code_verifier) returns an API key. That key is made for Vibe Code: its
//   calls on api.mistral.ai bill the plan's monthly Vibe Code budget, not
//   pay-as-you-go API credits. A key made the same way in the console
//   (Code > Vibe Code CLI) can be pasted instead.
// - Requests are plain OpenAI chat completions on https://api.mistral.ai/v1
//   with the key as a bearer token; the models are /v1/models. No private
//   protocol (the CLI's ACP layer is its IDE control plane, not its model
//   channel), so the loader re-signs each request, and puts an earlier
//   turn's thinking back in the typed part Mistral takes it (see
//   mistralBody below): Mistral turns an unknown message field away as 422
//   extra_forbidden.
// - Usage is the public billing read the CLI does:
//   GET api.mistral.ai/v1/billing/subscription (plan name, pay-as-you-go) and
//   GET api.mistral.ai/v1/billing/budget (vibe_budget: usage_percentage,
//   initial_budget, reset_at); the plan also comes from console's
//   /api/vibe/whoami.
//
// The provider id is "mistral-vibe", kept apart from the "mistral" preset
// (api.mistral.ai with the user's own API key).
import { createHash, randomBytes } from "node:crypto"

const ID = "mistral-vibe"

// bases are functions so tests can point them at a stand-in with the
// MISTRAL_VIBE_API_BASE / MISTRAL_VIBE_CONSOLE_API environment variables
const apiBase = () => (process.env.MISTRAL_VIBE_API_BASE || "https://api.mistral.ai/v1").replace(/\/+$/, "")
const consoleApi = () => (process.env.MISTRAL_VIBE_CONSOLE_API || "https://console.mistral.ai/api").replace(/\/+$/, "")

const POLL_EVERY_MS = 1500
const SIGN_IN_TTL_MS = 10 * 60 * 1000
// one sign-in call's own deadline: the console answers these in well under a
// second, so a call still open after this is a dead connection to replace
const SIGN_IN_CALL_MS = 20_000
const DEFAULT_LIMIT = { context: 262_144, output: 65_536 }

// Prices from https://docs.mistral.ai/inference/pricing (USD per 1M tokens,
// standard tier, checked 2026-11-06), for the current LLM models only. The
// keys are the ids the docs and /v1/models agree on, plus Large 4's billing
// name; an alias is priced through its own billing_model_name, so it follows
// the model behind it rather than a price kept for the alias. Older
// generations and the speech, OCR and embedding models keep models.dev's
// price when it has one.
const DOCS_PRICES = {
  "mistral-large-4": { input: 0.7, output: 2.1, cache_read: 0.07 },
  "mistral-large-4-0": { input: 0.7, output: 2.1, cache_read: 0.07 },
  "mistral-large-4-0-a": { input: 0.7, output: 2.1, cache_read: 0.07 },
  "mistral-small-2603": { input: 0.15, output: 0.6, cache_read: 0.015 },
  "ministral-14b-2512": { input: 0.2, output: 0.2, cache_read: 0.02 },
  "ministral-8b-2512": { input: 0.15, output: 0.15, cache_read: 0.015 },
  "ministral-3b-2512": { input: 0.1, output: 0.1, cache_read: 0.01 },
  "codestral-2508": { input: 0.3, output: 0.9, cache_read: 0.03 },
  "zai-glm-5-3": { input: 1.4, output: 4.4, cache_read: 0.14 },
  "zai-glm-5-3-flash": { input: 0.15, output: 0.5, cache_read: 0.03 },
  "deepseek-v4-1-flash-1017": { input: 0.3, output: 1.2, cache_read: 0.007 },
  // mistral-large-latest is deliberately absent: the vendor still bills it as
  // mistral-large-2512 (Large 3), so models.dev's price for it is the right one.
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener("abort", onAbort, { once: true })
  })

const keyOf = (auth) => (auth?.type === "api" || auth?.key ? auth.key : auth?.access) || ""

// ---- transport ----------------------------------------------------------
//
// Bun's fetch pools connections between requests. api.mistral.ai and
// console.mistral.ai are served behind Cloudflare, which closes an idle
// keep-alive connection on its own schedule; when the pool hands that socket
// to the next request, the write meets the closed peer and Bun fails the call
// before the request goes out:
//
//   ECONNRESET: The socket connection was closed unexpectedly. For more
//   information, pass verbose: true in the second argument to fetch()
//
// The dead socket is dropped with the error, so one retry takes a fresh
// connection. A POST is retried too, and only safely so: fetch resolves as
// soon as the response headers arrive, so an error thrown by the await means
// the response never started. A reset after the headers, a timeout and an
// abort come back as they are.
const STALE_SOCKET =
  /socket connection was closed unexpectedly|other side closed|connection closed|socket hang up/i

// STALE_CODES are the errno names both runtimes put on a connection the peer
// (or the pool) had already torn down: Node's undici reports ECONNRESET /
// UND_ERR_SOCKET, Bun its own ECONNRESET / ConnectionClosed, and a write to a
// half-closed socket is EPIPE.
const STALE_CODES = new Set(["ECONNRESET", "ECONNABORTED", "UND_ERR_SOCKET", "UND_ERR_CLOSED", "ConnectionClosed", "EPIPE"])

function staleSocket(e) {
  // a call the caller cancelled or that ran out of time says nothing about
  // the pool: it is the answer, not a socket the peer had already closed
  if (!e || typeof e !== "object") return false
  if (e.name === "AbortError" || e.name === "TimeoutError") return false
  for (const code of [e.code, e.cause?.code, e.errno, e.cause?.errno]) if (STALE_CODES.has(code)) return true
  return STALE_SOCKET.test(`${e.message ?? ""} ${e.cause?.message ?? ""}`)
}

// NET_CODES are the failures a sign-in's poll loop rides out: the network was
// briefly not there, or the edge was busy, and the same call a moment later
// is the right one. It is the loop's own retry, not the socket one above.
const NET_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
])

function transient(e) {
  if (!e || typeof e !== "object") return false
  if (e.name === "AbortError") return false
  if (e.transient === true || staleSocket(e)) return true
  if (e.name === "TimeoutError") return true
  return NET_CODES.has(e.code ?? e.cause?.code ?? e.errno)
}

// drain reads a response's body to its end and gives back the text, so its
// connection goes back to the pool reusable rather than half-read (a cancel
// would drop the socket). A body that fails mid-read is cancelled instead.
async function drain(res) {
  try {
    if (res?.body && !res.bodyUsed) return await res.text()
  } catch {}
  try {
    await res?.body?.cancel?.()
  } catch {}
  return ""
}

// RETRY_MS is the first pause before a stale-socket retry; each attempt
// waits a little longer, so a pool still handing back dead sockets is given
// the time to notice, without a caller's deadline being spent at once.
const RETRY_MS = 200
const READ_TRIES = 2
// the sign-in steps get one more try than a plain read: they run once, by
// hand, and a reset that eats them costs the user the whole browser round
// trip rather than a page of numbers
const SIGN_IN_TRIES = 3
const retryDelay = (attempt) => RETRY_MS * (attempt + 1) + Math.floor(Math.random() * 100)

// send is fetch with the stale-socket retry: a GET or HEAD twice, a POST once.
// A body that is a string, a Buffer or a Blob goes out again as it is; a
// Request's body is cloned ahead of the first send, because fetch spends it.
// A ReadableStream body is the one thing that can't be replayed, so that
// request is sent once and its error surfaces — and so is a Request whose
// body was locked before the clone, which would otherwise go out a second
// time with nothing left to send.
async function send(input, init = {}, { retries } = {}) {
  const method = String(init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
  const idempotent = method === "GET" || method === "HEAD" || method === "OPTIONS"
  const req = input instanceof Request ? input : null
  const streamed = init.body && typeof init.body === "object" && typeof init.body.getReader === "function"
  // the spare is taken before the first send consumes the original; an
  // init.body replaces the Request's own, so the spare only stands in when
  // there isn't one
  let spare = null
  if (req?.body && init.body === undefined) {
    try {
      spare = req.clone()
    } catch {}
  }
  const replayable = !streamed && (!req?.body || init.body !== undefined || spare !== null)
  const budget = replayable ? retries ?? (idempotent ? 2 : 1) : 0
  for (let attempt = 0; ; attempt++) {
    const arg = attempt > 0 && spare ? spare : input
    try {
      return await fetch(arg, init)
    } catch (e) {
      if (init.signal?.aborted || attempt >= budget || !staleSocket(e)) throw e
      await sleep(retryDelay(attempt), init.signal)
    }
  }
}

// readJSON is a request and its body as JSON, with the stale-socket retry
// covering both halves. fetch resolves at the response headers, so a peer
// that resets the connection after them fails res.text() instead — the same
// dead socket, one step later, and just as safe to ask again. Reads go
// through here, and so do the two sign-in steps whose repeat is harmless (a
// second start leaves an unused process behind, an exchange with the same
// token either hands out the key or does not); a chat body is streamed and
// is never read inside the retry.
async function readJSON(url, init = {}, { retries = READ_TRIES } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await send(url, init, { retries: 0 })
      if (!res.ok) {
        // a refusal's body is the server's own explanation of it; it is read
        // once, kept for the error message, and the connection goes back whole
        const text = await drain(res)
        return { res, data: null, text }
      }
      const text = await res.text()
      let data = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {}
      return { res, data, text }
    } catch (e) {
      if (init.signal?.aborted || attempt >= retries || !staleSocket(e)) throw e
      await sleep(retryDelay(attempt), init.signal)
    }
  }
}

// why says what a refusal said, in the few words the console puts in it
// (`{"detail":"..."}`, `{"message":"..."}`, `{"error":"..."}`), so a 4xx reads
// as the server's answer rather than only its number.
function why(text) {
  if (typeof text !== "string" || text === "") return ""
  try {
    const d = JSON.parse(text)
    const v = d?.detail ?? d?.message ?? d?.error ?? d?.error_description
    if (typeof v === "string" && v !== "") return `: ${v}`
  } catch {}
  const s = text.replace(/\s+/g, " ").trim()
  return s ? `: ${s.slice(0, 200)}` : ""
}

// ---- the browser sign-in (vibe's setup/auth/http_browser_sign_in_gateway) ----

const newVerifier = () => randomBytes(48).toString("base64url")
const challengeOf = (verifier) => createHash("sha256").update(verifier).digest("base64url")

// UA is the client identity the official CLI sends (mistral-vibe
// vibe/utils/http.py: get_user_agent). console.mistral.ai sits behind
// Cloudflare, and the sign-in endpoints are the ones it is most particular
// about: a request that names a bare runtime (`Bun/1.2.21`) is the one that
// gets a connection dropped under it, which is what a login that never
// finishes looks like. The same identity goes on every console and API call.
const UA = () => process.env.MISTRAL_VIBE_UA || "mistral-client-python/Mistral-Vibe/3.1.3"

// consoleHeaders are the sign-in calls' headers: the CLI's identity, and no
// keep-alive reuse — these are three one-shot calls in a row, and a
// connection the pool kept from the last one is exactly what Cloudflare has
// already closed by the time the next is written.
function consoleHeaders(extra = {}) {
  return {
    accept: "application/json",
    "user-agent": UA(),
    connection: "close",
    ...extra,
  }
}

// withTimeout gives a call its own deadline beside the caller's: whichever
// comes first ends it, and an abort the caller made still reads as one.
function withTimeout(signal, ms) {
  const t = AbortSignal.timeout(ms)
  if (!signal) return t
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, t]) : signal
}

async function startSignIn(signal) {
  const code_verifier = newVerifier()
  // readJSON, not send: the payload comes back in the body, and a reset that
  // lands between the headers and the body is the same dead socket one step
  // later. A second start on a fresh connection is harmless — the process it
  // leaves unused expires on its own.
  const { res, data: d, text } = await readJSON(
    `${consoleApi()}/vibe/sign-in`,
    {
      method: "POST",
      headers: consoleHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ code_challenge: challengeOf(code_verifier), code_challenge_method: "S256" }),
      // a start that hangs is retried by the deadline, not waited on forever
      signal: withTimeout(signal, SIGN_IN_CALL_MS),
    },
    { retries: SIGN_IN_TRIES }
  )
  if (!res.ok) throw new Error(`Mistral sign-in could not start (${res.status})${why(text)}`)
  if (!d?.process_id || !d?.sign_in_url || !d?.poll_url) throw new Error("Mistral sign-in answered an unexpected payload")
  return { process_id: d.process_id, sign_in_url: d.sign_in_url, poll_url: d.poll_url, expires_at: d.expires_at, code_verifier }
}

function signInResponseError(status, message) {
  const error = new Error(message)
  if (status === 429 || status >= 500) error.transient = true
  return error
}

async function pollSignIn(pollUrl, signal) {
  const { res, data, text } = await readJSON(
    pollUrl,
    { headers: consoleHeaders(), signal: withTimeout(signal, SIGN_IN_CALL_MS) },
    { retries: SIGN_IN_TRIES }
  )
  if (res.status === 410) return { status: "expired" }
  if (!res.ok) throw signInResponseError(res.status, `Mistral sign-in poll answered ${res.status}${why(text)}`)
  return data
}

async function exchangeSignIn(processId, exchangeToken, codeVerifier, signal) {
  // an exchange repeats on the same token, so a stale socket is safe to
  // retry here too: the server either hands out the key or has already
  // spent the token, and the second answer is the real one
  const { res, data: d, text } = await readJSON(
    `${consoleApi()}/vibe/sign-in/${encodeURIComponent(processId)}/exchange`,
    {
      method: "POST",
      headers: consoleHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ exchange_token: exchangeToken, code_verifier: codeVerifier }),
      signal: withTimeout(signal, SIGN_IN_CALL_MS),
    },
    { retries: SIGN_IN_TRIES }
  )
  if (!res.ok) throw signInResponseError(res.status, `Mistral sign-in exchange failed (${res.status})${why(text)}`)
  if (!d?.api_key) throw new Error("Mistral sign-in exchange returned no API key")
  return d.api_key
}

// whoami names the plan behind a key (console.mistral.ai/api/vibe/whoami)
async function whoami(key) {
  const { res, data } = await readJSON(`${consoleApi()}/vibe/whoami`, {
    headers: consoleHeaders({ Authorization: `Bearer ${key}` }),
    signal: AbortSignal.timeout(8000),
  })
  return res.ok ? data : null
}

function accountIdentity(who) {
  const kind = typeof who?.plan_type === "string" ? who.plan_type.trim().toLowerCase() : ""
  const name = typeof who?.plan_name === "string" ? who.plan_name.trim() : ""
  if (kind === "api") return { kind, plan: "Mistral Studio API" }
  if (kind === "chat" && name) {
    const plans = { INDIVIDUAL: "Mistral Pro", FREE: "Mistral Free", EDU: "Mistral Student", TEAM: "Mistral Team" }
    return { kind, plan: plans[name.toUpperCase()] ?? name }
  }
  if (kind === "mistral_code" && name) {
    const plans = { F: "Free Codestral", E: "Code Enterprise" }
    return { kind, plan: plans[name.toUpperCase()] ?? name }
  }
  return { kind }
}

// ---- models: /v1/models, limits filled from models.dev when it knows them ----

let devModels = null
async function modelsDev() {
  if (devModels) return devModels
  try {
    const { res, data } = await readJSON("https://models.dev/api.json", { signal: AbortSignal.timeout(5000) })
    devModels = res.ok ? (data?.mistral?.models ?? {}) : {}
  } catch {
    devModels = {}
  }
  return devModels
}

// priceOf is a model's list price as OpenCode and magpie take it: USD per
// 1M tokens, with the cache read and write beside input and output. docs
// first, then models.dev, and undefined when nothing prices it rather than
// a made-up zero.
function priceOf(m, dev) {
  const caps = m?.capabilities ?? {}
  const billing = typeof m?.billing_model_name === "string" ? m.billing_model_name : ""
  const aliases = Array.isArray(m?.aliases) ? m.aliases : []
  const names = [billing, ...aliases, m?.id].filter((id) => typeof id === "string" && id)
  const stated = names.map((id) => DOCS_PRICES[id]).find(Boolean)
  // a speech or non-chat model's models.dev price may be per minute, page or
  // character rather than per token, so only chat models without audio take it
  const audio =
    caps.audio === true || caps.audio_transcription === true || caps.audio_transcription_realtime === true || caps.audio_speech === true
  const chat = caps.completion_chat ?? true
  const p = stated ?? (chat && !audio ? names.map((id) => dev?.[id]?.cost).find(Boolean) : undefined)
  if (!p || typeof p !== "object") return undefined
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0)
  const cache = p.cache && typeof p.cache === "object" ? p.cache : {}
  return {
    input: n(p.input),
    output: n(p.output),
    cache: { read: n(p.cache_read ?? cache.read), write: n(p.cache_write ?? cache.write) },
  }
}

async function listModels(key) {
  const { res, data: j } = await readJSON(`${apiBase()}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) return null
  const dev = await modelsDev()
  const out = {}
  for (const m of j?.data ?? []) {
    if (!m?.id || typeof m.id !== "string") continue
    const billing = typeof m.billing_model_name === "string" ? m.billing_model_name : ""
    const aliases = Array.isArray(m.aliases) ? m.aliases : []
    const d = [billing, ...aliases, m.id].map((id) => dev[id]).find(Boolean) ?? {}
    const caps = m.capabilities ?? {}
    const image = caps.vision ?? d.attachment ?? false
    const reasoning = caps.reasoning ?? d.reasoning ?? false
    const toolcall = caps.function_calling ?? d.tool_call ?? true
    const chat = caps.completion_chat ?? true
    const context =
      Number(m.max_context_length) > 0 ? Number(m.max_context_length) : d.limit?.context ?? DEFAULT_LIMIT.context
    const inputs = {
      text: caps.ocr !== true,
      image: image === true,
      audio: caps.audio === true || caps.audio_transcription === true || caps.audio_transcription_realtime === true,
      video: false,
      pdf: Array.isArray(d.modalities?.input) && d.modalities.input.includes("pdf"),
    }
    const outputs = { text: chat === true, image: false, audio: caps.audio_speech === true, video: false, pdf: false }
    const modalities = (kinds) => Object.keys(kinds).filter((k) => kinds[k])
    const model = {
      name: d.name ?? m.id,
      limit: {
        context,
        output: d.limit?.output ?? DEFAULT_LIMIT.output,
      },
      tool_call: toolcall,
      attachment: image,
      reasoning,
      temperature: chat,
      // OpenCode 1.x's model shape, so magpie and 2.x see what the model
      // takes and gives (and leave a TTS or an embedding out of chat lists)
      modalities: { input: modalities(inputs), output: modalities(outputs) },
      capabilities: {
        temperature: chat,
        reasoning,
        attachment: image,
        toolcall,
        input: inputs,
        output: outputs,
        interleaved: false,
      },
    }
    const cost = priceOf(m, dev)
    if (cost) model.cost = cost
    out[m.id] = model
  }
  return out
}

// ---- usage: the billing reads (vibe's app_server/_billing.py) ----

async function readUsage(key) {
  const headers = { Authorization: `Bearer ${key}` }
  const ask = async (url) => {
    const { res, data } = await readJSON(url, { headers, signal: AbortSignal.timeout(8000) })
    return res.ok ? data : null
  }
  const [subscription, budget, who] = (await Promise.allSettled([
    ask(`${apiBase()}/billing/subscription`),
    ask(`${apiBase()}/billing/budget`),
    whoami(key),
  ])).map((read) => read.status === "fulfilled" ? read.value : null)
  const identity = accountIdentity(who)
  const vb = budget?.vibe_budget
  const ab = budget?.api_budget
  const windows = []
  const statusWindow = (name, display) => ({ name, display, aside: true })
  const windowOf = (name, w, aside) => {
    if (!Number.isFinite(w?.usage_percentage) || w.usage_percentage < 0 || w.initial_budget === 0) return null
    const resetsAt = w.reset_at ? Date.parse(w.reset_at) : NaN
    const span = Number.isFinite(resetsAt) ? Math.max(3600, Math.floor((resetsAt - Date.now()) / 1000)) : 30 * 86400
    const out = {
      name,
      used: w.usage_percentage,
      resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
      span,
    }
    if (Number.isFinite(w.initial_budget) && w.initial_budget > 0) {
      out.amount = Math.round(w.initial_budget * (w.usage_percentage / 100) * 1e6) / 1e6
      out.limit = w.initial_budget
      if (typeof w.currency === "string") out.unit = w.currency.trim().toUpperCase()
    }
    if (aside) out.aside = true
    return out
  }

  if (identity.kind === "api") {
    windows.push(statusWindow("Vibe Code account", "Studio API key. Create a Vibe CLI key under Code > Vibe CLI."))
  } else {
    const name = "Monthly Vibe Code"
    // The organization budget can be readable with a Studio key as well.
    const monthly = windowOf(name, vb, identity.kind !== "chat")
    windows.push(monthly ?? statusWindow(name, vb?.initial_budget === 0 ? "No monthly budget" : "Budget unavailable"))
    const payg = [vb?.payg_enabled, subscription?.vibe_payg_enabled].find((value) => typeof value === "boolean")
    windows.push(statusWindow("Pay as you go", payg === undefined ? "Unknown" : payg ? "On" : "Off"))
    if (!identity.plan) {
      const billingPlan = typeof subscription?.plan_name === "string" && subscription.plan_name.trim()
      const display = billingPlan ? `Plan not confirmed · Billing reports ${billingPlan}` : "Plan not confirmed"
      windows.push(statusWindow("Vibe Code account", display))
    }
  }
  const abm = windowOf("Platform API credits", ab, true)
  if (abm) windows.push(abm)
  return identity.plan ? { plan: identity.plan, windows } : { windows, signIn: "kept" }
}

// ---- an earlier turn's thinking, in the shape Mistral takes it ----

// api.mistral.ai reads each chat message strictly: a field it doesn't know
// turns the whole request away as 422 "Extra inputs are not permitted"
// (extra_forbidden, loc ["body","messages",2,"assistant",
// "reasoning_content"]). An earlier assistant turn's thinking comes back
// from most clients in one of these fields — reasoning_content (OpenCode,
// pi, Claude Code through a gateway), reasoning (OpenRouter's) and
// reasoning_details (OpenRouter's structured one) — so a conversation with
// a thinking turn in it never gets through. Mistral returns a thinking turn
// as a typed content part and takes it back that way, so the thinking goes
// there, ahead of the turn's own text, as magpie's own Mistral handling
// gives it (#494).
const THINKING_FIELDS = ["reasoning_content", "reasoning", "reasoning_details"]

// thinkingText is the thinking a message carries in THINKING_FIELDS.
function thinkingText(m) {
  for (const f of THINKING_FIELDS.slice(0, 2)) {
    const v = m[f]
    if (typeof v === "string" && v !== "") return v
  }
  const details = m.reasoning_details
  if (!Array.isArray(details)) return ""
  let out = ""
  for (const d of details) {
    if (!d || typeof d !== "object") continue
    if (typeof d.text === "string" && d.text !== "") out += d.text
    else if (typeof d.summary === "string") out += d.summary
  }
  return out
}

function stripExtraFields(value, allowed) {
  const extras = Object.keys(value).filter((field) => !allowed.includes(field))
  for (const field of extras) delete value[field]
  return extras.length > 0
}

// asMistralMessage follows Mistral's UserMessage and TextChunk schemas and
// puts thinking where Mistral takes it. A prefill (prefix) keeps its content.
function asMistralMessage(m) {
  const c = m.content
  let changed = false
  if (Array.isArray(c)) {
    for (const part of c) {
      if (part?.type === "text" && stripExtraFields(part, ["type", "text"])) changed = true
    }
  }
  if (m.role === "user") return stripExtraFields(m, ["role", "content"]) || changed
  if (!THINKING_FIELDS.some((f) => f in m)) return changed
  const think = thinkingText(m)
  for (const f of THINKING_FIELDS) delete m[f]
  if (think === "" || m.role !== "assistant" || m.prefix === true) return true
  const part = { type: "thinking", thinking: [{ type: "text", text: think }] }
  if (typeof c === "string") m.content = c === "" ? [part] : [part, { type: "text", text: c }]
  else if (Array.isArray(c)) m.content = [part, ...c]
  else m.content = [part]
  return true
}

// mistralBody is a chat request's body with every message's thinking in the
// shape Mistral takes, and without the fields it turns away. A body with no
// such field comes back as it was, byte for byte, and so does one that isn't
// a chat request's JSON.
function mistralBody(body) {
  if (typeof body !== "string") return body
  let q
  try {
    q = JSON.parse(body)
  } catch {
    return body
  }
  if (!q || typeof q !== "object" || !Array.isArray(q.messages)) return body
  let changed = false
  for (const m of q.messages) if (m && typeof m === "object" && asMistralMessage(m)) changed = true
  return changed ? JSON.stringify(q) : body
}

// ---- the plugin ----

export const MistralVibeAuthPlugin = async ({ client } = {}) => ({
  config: async (cfg) => {
    cfg.provider ??= {}
    cfg.provider[ID] ??= {
      name: "Mistral Vibe Code",
      npm: "@ai-sdk/openai-compatible",
      api: apiBase(),
      models: {},
    }
  },
  auth: {
    provider: ID,
    usage: async (getAuth) => {
      const key = keyOf(await getAuth())
      if (!key) return { error: "Not signed in", windows: [] }
      return readUsage(key)
    },
    loader: async (getAuth) => {
      const auth = await getAuth()
      const key = keyOf(auth)
      if (!key) return {}
      return {
        baseURL: apiBase(),
        apiKey: "mistral-vibe", // the engine's placeholder; the fetch below signs
        async fetch(input, init = {}) {
          const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
          headers.set("Authorization", `Bearer ${key}`)
          // 与官方 CLI 一致的客户端标识（mistral-vibe vibe/utils/http.py: get_user_agent）
          if (!headers.has("user-agent")) headers.set("user-agent", process.env.MISTRAL_VIBE_UA || "mistral-client-python/Mistral-Vibe/3.1.3")
          const body = mistralBody(init.body)
          if (body !== init.body) {
            // the length the engine counted is not the one sent
            headers.delete("content-length")
            return send(input, { ...init, headers, body })
          }
          return send(input, { ...init, headers })
        },
      }
    },
    methods: [
      {
        type: "oauth",
        label: "Sign in with Mistral (browser)",
        authorize: async (_inputs, { signal } = {}) => {
          const p = await startSignIn(signal)
          return {
            url: p.sign_in_url,
            instructions: "Sign in to your Mistral account on the page that opens. The sign-in finishes here by itself.",
            method: "auto",
            callback: async (_code, { signal: cbSignal } = {}) => {
              // the host's authorize signal often ends with the authorize
              // call; using it here would cancel the first poll at once, and
              // the sign-in would never be seen through
              const s = cbSignal ?? (signal?.aborted ? undefined : signal)
              const deadline = (Date.parse(p.expires_at) || Date.now() + SIGN_IN_TTL_MS)
              // a poll that fails on a dead pooled socket, a 429 or a 5xx is
              // the network, not the sign-in: the loop asks again until the
              // link's own deadline. A 4xx that isn't 410 is the server
              // refusing the process, and asking again would only repeat it.
              let misses = 0
              for (;;) {
                let r
                try {
                  r = await pollSignIn(p.poll_url, s)
                  misses = 0
                } catch (e) {
                  if (s?.aborted) throw e
                  if (!transient(e)) return { type: "failed", error: e?.message ?? String(e) }
                  if (Date.now() > deadline) return { type: "failed", error: `Sign-in poll failed: ${e?.message ?? e}` }
                  misses++
                  await sleep(Math.min(POLL_EVERY_MS * misses, 10_000), s)
                  continue
                }
                if (r?.status === "completed" && r.exchange_token) {
                  // the token stays good until the process expires, so a
                  // transient failure here is asked again rather than thrown
                  // away: the user's browser round trip is not spent twice
                  for (;;) {
                    try {
                      const key = await exchangeSignIn(p.process_id, r.exchange_token, p.code_verifier, s)
                      const who = await whoami(key).catch(() => null)
                      const out = { type: "success", key, metadata: { plan: accountIdentity(who).plan, vibeEntitlement: who?.has_paid_vibe_entitlement } }
                      if (who?.customer_id != null) out.accountId = String(who.customer_id)
                      return out
                    } catch (e) {
                      if (!transient(e) || Date.now() > deadline) return { type: "failed", error: `Sign-in exchange failed: ${e?.message ?? e}` }
                      await sleep(POLL_EVERY_MS, s)
                    }
                  }
                }
                if (r?.status === "expired") return { type: "failed", error: "The sign-in expired; start it again" }
                if (r?.status === "denied") return { type: "failed", error: r.message || "The sign-in was denied" }
                if (r?.status === "error") return { type: "failed", error: r.message || "The sign-in failed" }
                if (Date.now() > deadline) return { type: "failed", error: "The sign-in timed out; start it again" }
                await sleep(POLL_EVERY_MS, s)
              }
            },
          }
        },
      },
      {
        type: "api",
        label: "Vibe Code API key",
        placeholder: "key made in console.mistral.ai under Code > Vibe CLI",
      },
    ],
  },
  provider: {
    id: ID,
    async models(provider, { auth } = {}) {
      const key = keyOf(auth)
      if (!key) return provider?.models ?? {}
      const got = await listModels(key).catch(() => null)
      return got && Object.keys(got).length ? got : (provider?.models ?? {})
    },
  },
})

// for tests
export const _internal = {
  startSignIn,
  pollSignIn,
  exchangeSignIn,
  whoami,
  listModels,
  readUsage,
  keyOf,
  priceOf,
  DOCS_PRICES,
  mistralBody,
  THINKING_FIELDS,
  ID,
  apiBase,
  consoleApi,
  send,
  readJSON,
  drain,
  staleSocket,
  transient,
  why,
  SIGN_IN_TRIES,
  READ_TRIES,
}
