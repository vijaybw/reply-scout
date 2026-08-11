// Reply Scout — background service worker
// Receives a batch of posts from the content script, scores them with either
// the Claude API or a local LM Studio server (OpenAI-compatible), returns results.

// DEFAULT_THESIS / DEFAULT_RUBRIC / DEFAULT_DIGEST_FOCUS / DEFAULT_VOICE
// come from defaults.js, the same file options.html loads for the settings
// page — this is what makes the example persona real functional behavior
// (getSettings() below) rather than just placeholder text in a form.
// importScripts is a real global in the MV3 service worker context but
// doesn't exist under Node, where the test suite requires this file
// directly — fall back to a plain require() there instead.
if (typeof importScripts === "function") {
  importScripts("defaults.js");
} else {
  Object.assign(globalThis, require("./defaults.js"));
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-sonnet-4-6";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ANTHROPIC_TIMEOUT_MS = 60_000;   // Claude API — generous, but a hung request shouldn't block the queue forever
const LOCAL_TIMEOUT_MS = 180_000;      // local reasoning models legitimately take 20-45s+; this only catches a truly stuck one
const IMAGE_FETCH_TIMEOUT_MS = 30_000; // just downloading from a CDN, not running inference

// Without this, a single hung request — network stall, a wedged local
// server — blocks the entire global single-flight queue indefinitely, with
// no recovery but reloading the extension.
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// GLOBAL single-flight queue. Content scripts serialize per-tab, but every
// x.com tab runs its own scanner — without this, two tabs fire concurrent
// requests and local MLX engines can OOM-crash. All scoring, from all tabs,
// runs strictly one-at-a-time with a small gap between requests.
let queueTail = Promise.resolve();
function enqueue(task) {
  const run = queueTail.then(task, task);
  queueTail = run.then(() => sleep(500), () => sleep(500));
  return run;
}

// MV3 service workers can be suspended by Chrome after a period of
// perceived inactivity — even mid-request, in practice, on long-running
// local-model calls (observed as "Client disconnected" in LM Studio's own
// logs, aborting generation part-way through). An open Port counts as
// active use and keeps the worker alive for its lifetime; content.js opens
// one right before a long call and closes it once the response lands.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "keepalive") {
    // Just having the port open isn't reliably enough to stop Chrome from
    // treating this worker as idle mid-fetch — observed in practice as
    // "Client disconnected" in LM Studio's logs at a suspiciously
    // consistent ~15-25s mark, well under any of our own timeouts. Actually
    // receiving a message over the port is unambiguous activity, so
    // content.js pings it periodically while a request is in flight.
    port.onMessage.addListener(() => {});
    port.onDisconnect.addListener(() => {});
  }
});

// Pushes the eventual result back as its own message, correlated by
// requestId, instead of relying on the original sendResponse callback.
// Chrome's message channel for a single sendMessage/onMessage exchange has
// its own lifetime independent of the service worker process itself — a
// multi-batch digest can legitimately run for several minutes, longer than
// that exchange is built to last ("message channel closed before a response
// was received").
//
// Targeted at the specific tab that sent the request (chrome.tabs.sendMessage)
// rather than broadcast via chrome.runtime.sendMessage — evidence from real
// use showed the underlying work completing successfully in the background
// while the broadcast result silently never reached the panel, leaving it
// stuck despite nothing actually being wrong with the scoring/digest itself.
// Falls back to a broadcast only if we somehow don't have a tab id.
function pushToTab(tabId, message) {
  if (tabId != null) {
    chrome.tabs.sendMessage(tabId, message).catch(() => {});
  } else {
    chrome.runtime.sendMessage(message).catch(() => {});
  }
}

function pushResult(tabId, type, requestId, payload) {
  pushToTab(tabId, { type, requestId, ...payload });
}

// Flags the subset of errors that mean "you haven't finished setting this
// up" rather than a transient/runtime failure (timeout, rate limit, bad
// parse) — content.js uses this to show an "Open Settings" button inline
// instead of a plain warning the user can't act on directly.
const SETTINGS_ERROR = /No API key set|API key rejected|Could not reach LM Studio/;
function isSettingsError(msg) {
  return SETTINGS_ERROR.test(String(msg || ""));
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender?.tab?.id;
  if (msg.type === "SCORE_POSTS") {
    enqueue(() => scorePosts(msg.posts))
      .then((results) => pushResult(tabId, "SCORE_RESULT", msg.requestId, { ok: true, results }))
      .catch((err) => {
        const error = String(err.message || err);
        pushResult(tabId, "SCORE_RESULT", msg.requestId, { ok: false, error, needsSettings: isSettingsError(error) });
      });
    return;
  }
  if (msg.type === "GENERATE_DIGEST") {
    enqueue(() => generateDigest(msg.posts, msg.requestId, tabId))
      .then((digest) => pushResult(tabId, "DIGEST_RESULT", msg.requestId, { ok: true, digest }))
      .catch((err) => {
        const error = String(err.message || err);
        pushResult(tabId, "DIGEST_RESULT", msg.requestId, { ok: false, error, needsSettings: isSettingsError(error) });
      });
    return;
  }
  if (msg.type === "OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
  }
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

async function getSettings() {
  const defaults = {
    provider: "anthropic",           // "anthropic" | "local"
    apiKey: "",
    localBaseUrl: "http://localhost:1234/v1",
    localModel: "",                  // LM Studio uses the loaded model if blank
    thesis: DEFAULT_THESIS,           // the same worked-example persona shown in settings — scoring/drafting
    rubric: DEFAULT_RUBRIC,           // work immediately, even before the user has ever opened Settings
    voice: DEFAULT_VOICE,
    minScore: 6,
    processImages: false,            // send each post's own photo/video thumbnail along with its text
    localOcrModel: "",               // optional: OCR-specialized local model id, used instead of vision on the main model
    digestFocus: DEFAULT_DIGEST_FOCUS, // what the "Generate digest" button should surface/skip
  };
  return chrome.storage.local.get(defaults);
}

// Shared between buildSystemPrompt (per-post scoring/replies) and
// buildDigestSystemPrompt (digest draft) — both write ready-to-send text in
// the user's voice, so both need the same voice samples and AI-tell
// guardrails. Originally only lived in buildSystemPrompt; the digest's draft
// silently had neither, which is exactly why it read as generic/corporate
// even though the main reply-scoring path didn't.
function buildVoiceAndTellsSection(s) {
  return [
    "== VOICE (write in the user's voice; match their restraint) ==",
    s.voice ||
      "(No voice samples set — paste 3-8 real posts/replies you've written into Voice samples in settings. Real examples beat any style instruction. Until then, default to plain, short, declarative sentences. No hype words, no exclamation points, no emojis, no hashtags.)",
    "",
    "== AVOID THESE AI TELLS ==",
    "- Pronoun choice (I vs. we) should match how the voice samples actually use it in a similar context — a personal reaction/opinion vs. describing your own team's work are often different registers for the same person. Don't default to a uniform choice that ignores that pattern.",
    '- Never use negative-parallelism / false-contrast framing: "It\'s not X, it\'s Y", "Not just X, but Y", "X isn\'t about Y — it\'s about Z". State the point once, directly.',
    "- No aphoristic one-line \"wisdom\" closers (e.g. \"Real research starts with a question, not a conclusion.\"). If there's nothing substantive left to add, stop instead of manufacturing a closing platitude.",
    "- Skip AI-coded vocabulary: delve, tapestry, testament, beacon, realm, elevate, foster, leverage, unpack, underscore, navigate, landscape, resonate, seamless, robust, holistic.",
    "- No em dash used as a dramatic pivot. Use a period or comma instead.",
    "- No throat-clearing openers (\"Great point\", \"Interesting question\", \"I think\", \"I appreciate the point\").",
    "- Don't glue sentences with transition words (moreover, furthermore, additionally). Most consecutive sentences need no connector.",
    "- Vary sentence length and rhythm — real writing is uneven, not uniformly polished.",
    "- Reference something specific and concrete from the post (a number, a named thing, an actual claim) instead of restating the topic in the abstract.",
    "- Take an actual position instead of gesturing at \"balance\" or \"both sides\" — a real reply usually agrees, disagrees, or adds a specific fact, not all three hedged together. A reply that's entirely questions, with no stance or fact of your own anywhere in it, is the same failure in a different shape — asking a genuine question is fine as one line inside a reply that also says something, never as the whole reply. Never stack more than one question in a single reply.",
    "- No hype words, no exclamation points, no emojis, no hashtags — regardless of what the voice samples do or don't show.",
    "",
  ];
}

// Shared with buildDigestSystemPrompt for the same reason as the voice/tells
// section above — this used to live only in the digest prompt (worded much
// more strongly than buildSystemPrompt's old one-liner) after a real digest
// draft claimed "our internal review process" out of nowhere. The per-post
// reply path has the same failure mode and had the weaker wording, so it's
// just as likely to invent a detail about the user's team — same parity gap,
// different rule.
function buildFactInventionRule() {
  return "Never invent facts, numbers, outcomes, or specifics about the user's own team, process, or organization (e.g. \"our internal review process\", \"we cut this by 40%\", \"our on-call overhead\", \"our event-driven services\", \"the manual tuning loop that currently dominates our pipeline\") — you have no knowledge of these, even if the voice samples show the user confidently discussing their own real work elsewhere. That confident tone is something to imitate; the specific claims inside it are not — the samples show you HOW the user sounds when they know something firsthand, not WHAT is currently true about their operations. If you don't have a real specific to reference, engage with the post's own content and general expertise instead of manufacturing an equivalent-sounding detail about the user's team to fill the gap.";
}

function buildSystemPrompt(s, hasImages, hasAnnotations) {
  const lines = [
    "You score social posts for reply-worthiness and draft replies. You work for one person promoting their own genuine work. You are advisory only; a human reviews and posts everything by hand.",
    "",
    "== THESIS (what every reply must ultimately advance) ==",
    s.thesis || "(No thesis set. Score conservatively and say so in reasons.)",
    "",
    "== SCORING RUBRIC ==",
    s.rubric || "(No rubric set. Use: relevance to thesis, ability to add genuine value, author reachability.)",
    "",
    ...buildVoiceAndTellsSection(s),
    "- Across a batch of replies, don't reuse the same rhetorical move in every one (e.g. always closing on \"a mentor would help you...\"). If you notice yourself repeating a structure, use a different one or write nothing.",
    "",
  ];
  if (hasAnnotations) {
    lines.push(
      "Note: bracketed text appended to a post like [image alt text: ...] or [image text: ...] is not something the author wrote — it's a machine-derived description or transcription of an attached image, included for context.",
      ""
    );
  }
  if (hasImages) {
    lines.push(
      "== IMAGES ==",
      "Some posts include an attached photo or video thumbnail after their text in this message, labeled with the post's id. Weigh it as part of that post's content when scoring and drafting — it may be the whole point of the post (a screenshot, chart, meme, etc.), not just decoration.",
      ""
    );
  }
  lines.push(
    "== HARD RULES FOR REPLIES ==",
    "- " + buildFactInventionRule(),
    "- Never pitch or link-drop. Add value first; the profile does the selling.",
    "- No sycophancy ('Great post!'), no engagement-bait, no questions purely to farm replies.",
    "- 1-3 sentences. Plain words. It should read like a knowledgeable person talking, not marketing.",
    "- If the honest best move is to not reply, score low and set reply to null.",
    "",
    "== OUTPUT ==",
    "Respond with ONLY a JSON array, no prose, no markdown fences. One object per input post:",
    '[{"id": "<same id you were given>", "score": <0-10, one decimal allowed>, "reason": "<one short sentence: why this score>", "reply": "<draft reply>" or null}]',
    "Only include a non-null reply when score >= " + (s.minScore ?? 6) + "."
  );
  return lines.join("\n");
}

function buildUserContent(posts, imagesByPostId = {}) {
  return (
    "Score these posts. Return only the JSON array.\n\n" +
    JSON.stringify(
      posts.map((p) => ({
        id: p.id,
        author: p.author,
        handle: p.handle,
        text: p.text,
        engagement: p.engagement,
        imageCount: (imagesByPostId[p.id] || []).length || undefined,
      })),
      null,
      2
    )
  );
}

// ---------- images ----------

// Requests a smaller rendition from Twitter's image CDN instead of the
// full-size original — "small" for general vision (cost control), "medium"
// for OCR (small text needs more pixels to read reliably).
function withImageSize(url, sizeName) {
  try {
    const u = new URL(url);
    u.searchParams.set("name", sizeName);
    return u.toString();
  } catch (_) {
    return url;
  }
}

// Fetches an image and base64-encodes it for the provider's vision API.
// Chunked to avoid blowing the call stack on String.fromCharCode(...bytes)
// for larger images.
async function fetchImageAsBase64(url, sizeName) {
  const res = await fetchWithTimeout(withImageSize(url, sizeName), {}, IMAGE_FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Image fetch failed (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  const mediaType = (res.headers.get("content-type") || "image/jpeg").split(";")[0];
  return { mediaType, data: btoa(binary) };
}

// Only bother fetching/reading an image when the post's own words probably
// aren't enough signal on their own — a substantial caption already gives
// the scorer something to work with, so spending an extra model call to
// re-describe the attached photo adds cost/latency for little marginal
// value. This also directly bounds the "how common are images really"
// unknown: most captioned posts (including most replies) skip the expensive
// path entirely. Video poster frames are skipped outright — see extractImages'
// `kind` field in content.js. Hard-capped per batch as a latency safety net,
// since these calls run one at a time against the local model, same as
// scoring (see the enqueue() comment above) — a meme-heavy batch shouldn't
// be able to make a scan take minutes.
const MIN_TEXT_FOR_IMAGE_SKIP = 40;
const MAX_IMAGES_PER_BATCH = 6;

function pickImagesToProcess(posts) {
  const picked = [];
  for (const p of posts) {
    if (p.text.trim().length >= MIN_TEXT_FOR_IMAGE_SKIP) continue;
    for (const imgMeta of p.images || []) {
      if (imgMeta.kind === "video") continue;
      picked.push({ post: p, imgMeta });
      if (picked.length >= MAX_IMAGES_PER_BATCH) return picked;
    }
  }
  return picked;
}

// Resolves a gated list of {post, imgMeta} pairs (see pickImagesToProcess)
// to base64, keyed by post id. A failed fetch drops just that image rather
// than failing the whole batch.
async function resolveImagesFor(picks) {
  const map = {};
  await Promise.all(
    picks.map(async ({ post, imgMeta }) => {
      const img = await fetchImageAsBase64(imgMeta.url, "small").catch(() => null);
      if (!img) return;
      (map[post.id] || (map[post.id] = [])).push(img);
    })
  );
  return map;
}

// The exact prompt olmOCR's own toolkit uses for a single image with no
// PDF-derived anchor text — sourced from allenai/olmocr's prompts.py
// (build_no_anchoring_v4_yaml_prompt), not guessed. It expects the model to
// reply with markdown, front-matter metadata on top, followed by the
// transcribed text — which extractOcrText() below strips down to just the text.
const OLMOCR_PROMPT =
  "Attached is one page of a document that you must process. " +
  "Just return the plain text representation of this document as if you were reading it naturally. Convert equations to LateX and tables to HTML.\n" +
  "If there are any figures or charts, label them with the following markdown syntax ![Alt text describing the contents of the figure](page_startx_starty_width_height.png)\n" +
  "Return your output as markdown, with a front matter section on top specifying values for the primary_language, is_rotation_valid, rotation_correction, is_table, and is_diagram parameters.";

// olmOCR's prompt above is tuned to that specific model's fine-tuning — a
// general small VLM (Qwen2-VL, moondream, etc.) wasn't trained on its
// YAML-front-matter instructions and does better with a plain ask that also
// covers non-document images (memes, photos), which olmOCR isn't built for.
const GENERIC_IMAGE_PROMPT =
  "Transcribe any text visible in this image exactly as it appears. If there is no text, briefly describe what the image shows (a photo, chart, meme, screenshot, etc.) in one or two sentences. Be concise and factual — no commentary or opinions.";

function ocrPromptFor(modelId) {
  return /olmocr/i.test(modelId || "") ? OLMOCR_PROMPT : GENERIC_IMAGE_PROMPT;
}

function extractOcrText(raw) {
  const stripped = raw.replace(/^\s*---[\s\S]*?---\s*/, "").trim();
  return stripped || raw.trim();
}

// Small vision models sometimes default to a "grounding" behavior — bare
// bounding-box coordinates — instead of following a plain-language
// instruction (observed in practice: "(21,9),(984,983)"). That's not a
// description or transcription, so it shouldn't get folded into a post.
function looksLikeGarbageOcr(text) {
  const t = text.trim();
  if (!t) return true;
  if (/^(\(\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*\)\s*,?\s*)+$/.test(t)) return true; // coordinate-only output
  if (!/[a-zA-Z]{3,}/.test(t)) return true; // no real words at all
  return false;
}

// Transcribes one image with a dedicated local OCR/vision model, kept
// entirely separate from the main scoring model — the scoring model never
// needs vision support in this path.
async function ocrImage(s, url) {
  const img = await fetchImageAsBase64(url, "medium");
  const content = [
    { type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.data}` } },
    { type: "text", text: ocrPromptFor(s.localOcrModel) },
  ];
  const raw = await callLocal(s, "", content, s.localOcrModel);
  const text = extractOcrText(raw);
  return looksLikeGarbageOcr(text) ? "" : text;
}

function imageBlock(img, format) {
  return format === "openai"
    ? { type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.data}` } }
    : { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } };
}

// Builds the mixed text+image content array for vision-capable requests.
// `format` picks the provider's image block shape: Anthropic's "image"/base64
// source, or the OpenAI-compatible "image_url" data URI LM Studio expects.
function buildMultimodalContent(posts, imagesByPostId, format) {
  const blocks = [
    {
      type: "text",
      text:
        buildUserContent(posts, imagesByPostId) +
        "\n\nImage(s) for the posts that have them follow below, each preceded by its post id.",
    },
  ];
  for (const p of posts) {
    const imgs = imagesByPostId[p.id] || [];
    if (imgs.length === 0) continue;
    blocks.push({ type: "text", text: `Image(s) for post ${p.id}:` });
    for (const img of imgs) blocks.push(imageBlock(img, format));
  }
  return blocks;
}

async function callAnthropic(s, systemPrompt, userContent) {
  if (!s.apiKey) {
    throw new Error("No API key set. Open settings and paste your Anthropic API key, or switch provider to Local (LM Studio).");
  }
  let res;
  try {
    res = await fetchWithTimeout(
      ANTHROPIC_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": s.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 4000,
          system: systemPrompt,
          messages: [{ role: "user", content: userContent }],
        }),
      },
      ANTHROPIC_TIMEOUT_MS
    );
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(`Anthropic request timed out after ${ANTHROPIC_TIMEOUT_MS / 1000}s. Try again.`);
    }
    throw e;
  }
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json())?.error?.message || ""; } catch (_) {}
    if (res.status === 401) throw new Error("API key rejected (401). Check the key in settings.");
    if (res.status === 429) throw new Error("Rate limited (429). Wait a moment and scan again.");
    throw new Error(`API error ${res.status}. ${detail}`);
  }
  const data = await res.json();
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

// LM Studio's message for a non-vision model handed image content — not a
// crash, so retrying after a reload delay would just fail the same way again.
const NO_VISION_SUPPORT = /does not support image/i;
// Already waited the full LOCAL_TIMEOUT_MS once — that's generous enough
// that a repeat is more likely stuck than transient. Fail fast instead of
// doubling the wait to 6+ minutes.
const LOCAL_TIMED_OUT = /didn't respond within/i;

async function callLocal(s, systemPrompt, userContent, modelOverride, maxTokens, reasoningEffort) {
  // One retry with backoff: after a crash, LM Studio's JIT loader needs a few
  // seconds to bring the model back before the retry can succeed.
  try {
    return await callLocalOnce(s, systemPrompt, userContent, modelOverride, maxTokens, reasoningEffort);
  } catch (firstErr) {
    const firstMsg = String(firstErr.message || firstErr);
    if (NO_VISION_SUPPORT.test(firstMsg)) {
      throw new Error(
        firstMsg +
        ' — turn off "Include images when scoring" in settings, or load a vision-capable model (e.g. Qwen2-VL, LLaVA) in LM Studio.'
      );
    }
    if (LOCAL_TIMED_OUT.test(firstMsg)) {
      throw firstErr;
    }
    await sleep(6000);
    try {
      return await callLocalOnce(s, systemPrompt, userContent, modelOverride, maxTokens, reasoningEffort);
    } catch (secondErr) {
      throw new Error(String(secondErr.message || secondErr) + " (retried once after 6s)");
    }
  }
}

async function callLocalOnce(s, systemPrompt, userContent, modelOverride, maxTokens, reasoningEffort) {
  const base = (s.localBaseUrl || "http://localhost:1234/v1").replace(/\/+$/, "");
  let res;
  try {
    res = await fetchWithTimeout(
      base + "/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelOverride || s.localModel || "local-model",
          temperature: 0.4,
          max_tokens: maxTokens || 2000,
          // Only meaningful to reasoning models (e.g. gpt-oss) that support it;
          // non-reasoning models on an OpenAI-compatible server just ignore it.
          // Keeps thinking from eating the max_tokens budget before the model
          // writes the actual JSON output.
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent },
          ],
        }),
      },
      LOCAL_TIMEOUT_MS
    );
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(`LM Studio didn't respond within ${LOCAL_TIMEOUT_MS / 1000}s — it may be stuck. Check LM Studio, or try a smaller batch.`);
    }
    throw new Error(
      "Could not reach LM Studio at " + base +
      ". Is the server running? In LM Studio: Developer tab → Start Server (port 1234) and enable CORS."
    );
  }
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json())?.error?.message || ""; } catch (_) {}
    throw new Error(`LM Studio error ${res.status}. ${detail || "Check that a model is loaded."}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text) throw new Error("Empty response from the local model. Try a larger model or a smaller batch.");
  return text;
}

// Picks the configured provider — the `s.provider === "local" ? callLocal(...)
// : callAnthropic(...)` dispatch was repeated at every call site with slightly
// different args; maxTokens/reasoningEffort are local-only concepts that
// callAnthropic ignores (it has its own fixed max_tokens and no reasoning
// controls), which is why they're just dropped on that branch rather than
// threaded through.
async function callModel(s, systemPrompt, userContent, { maxTokens, reasoningEffort } = {}) {
  return s.provider === "local"
    ? callLocal(s, systemPrompt, userContent, undefined, maxTokens, reasoningEffort)
    : callAnthropic(s, systemPrompt, userContent);
}

function parseResults(text) {
  // Strip markdown fences and any <think>...</think> blocks reasoning models emit
  const clean = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```json|```/g, "")
    .trim();
  try {
    const parsed = JSON.parse(clean);
    if (Array.isArray(parsed)) return parsed;
  } catch (_) {}
  const match = clean.match(/\[[\s\S]*\]/);
  if (match) {
    const parsed = JSON.parse(match[0]);
    if (Array.isArray(parsed)) return parsed;
  }
  throw new Error("Could not parse the model's response as JSON. Local models sometimes ramble — try again, use a smaller batch, or a stronger model.");
}

async function scorePosts(posts) {
  const s = await getSettings();
  if (!posts || posts.length === 0) {
    throw new Error("No posts found on screen. Scroll a feed, list, or search results into view first.");
  }

  // Decide which images are worth processing before the alt-text merge below
  // mutates post.text — pickImagesToProcess judges by original caption length.
  const toProcess = s.processImages ? pickImagesToProcess(posts) : [];

  let hasAnnotations = false;

  // Free enrichment: fold in any alt text the author provided, regardless of
  // the images setting — it's already-extracted text, no fetch or cost.
  for (const p of posts) {
    const altText = (p.images || []).map((img) => img.alt).filter(Boolean).join(" / ");
    if (altText) {
      p.text = `${p.text}\n[image alt text: ${altText}]`;
      hasAnnotations = true;
    }
  }

  let hasVisionImages = false;
  let imagesByPostId = {};

  if (toProcess.length > 0) {
    if (s.provider === "local" && s.localOcrModel) {
      // OCR pre-pass: transcribe each image with a dedicated local model and
      // fold the text in like alt text. The main scoring model stays
      // text-only and never needs vision support.
      for (const { post, imgMeta } of toProcess) {
        try {
          const ocrText = await ocrImage(s, imgMeta.url);
          if (ocrText) {
            post.text = `${post.text}\n[image text: ${ocrText}]`;
            hasAnnotations = true;
          }
        } catch (_) {
          // OCR is best-effort — skip a failed image rather than failing the batch.
        }
      }
    } else {
      imagesByPostId = await resolveImagesFor(toProcess);
      hasVisionImages = Object.keys(imagesByPostId).length > 0;
    }
  }

  const systemPrompt = buildSystemPrompt(s, hasVisionImages, hasAnnotations);
  const userContent = hasVisionImages
    ? buildMultimodalContent(posts, imagesByPostId, s.provider === "local" ? "openai" : "anthropic")
    : buildUserContent(posts);
  // 3500 (not the old 2000 default) so a reasoning model's thinking doesn't
  // crowd out the actual JSON output — observed truncating mid-response
  // and occasionally returning empty content otherwise. "low" effort keeps
  // it from over-thinking a style-constrained scoring/drafting task.
  const text = await callModel(s, systemPrompt, userContent, { maxTokens: 3500, reasoningEffort: "low" });
  return parseResults(text);
}

// ---------- digest ----------
// A separate, on-demand "what actually matters" summary — distinct from the
// per-post reply-scoring rubric above. Triggered only by a manual button
// click (never automatically), text-only (no image handling), one request
// per click rather than the batched auto-scan pipeline.

const DIGEST_HISTORY_KEY = "digestHistory";
const DIGEST_HISTORY_DAYS = 3;   // "skip what I already saw" window, a little past a calendar day for weekend gaps
const DIGEST_BATCH_SIZE = 25;    // stage-1 chunk size — keeps each triage call a reasonable size for local models

function buildDigestSystemPrompt(s, preFiltered) {
  return [
    "You build a short morning digest from a social media feed, for someone who wants to spend a few minutes reading instead of scrolling.",
    "",
    "== WHAT TO SURFACE (in their own words) ==",
    s.digestFocus || "(No digest focus set. Default: unusual engagement, notable industry debates, and anything a competitor or well-known account announced.)",
    "",
    "The voice and AI-tell rules below apply ONLY to draft.text — the actual reply/post you're writing. Item summaries and whyCare stay neutral, third-person, factual description; they are not written in the user's voice.",
    "",
    ...buildVoiceAndTellsSection(s),
    "== HARD RULES ==",
    "- Pick at most 8 items, fewer if fewer genuinely qualify. Never pad with filler just to hit a count.",
    "- Skip engagement-bait, giveaways, and anything that's just farming replies or quote-tweets.",
    "- Never invent a url — only use urls that appear in the input.",
    "- Two-line summary: what the post actually says, specific, not vague hype.",
    "- Why-you-care: one sentence connecting it to their stated focus above — be specific, not generic filler.",
    "- Lean toward including a plausible, on-topic post rather than excluding it — reserve exclusion for posts that are genuinely off-topic, spam, or low-effort. An empty items list should be the rare exception, not the usual outcome, whenever the input has more than a couple of posts.",
    preFiltered
      ? "- Every post below already passed an earlier relevance pass against the focus above — it wasn't randomly sampled. Default to including it as an item unless it's clearly a bad fit on a second look; don't re-run the same strict filter from scratch and reject most of them."
      : "",
    "",
    "- draft is REQUIRED and must never be null as long as you were given at least one post below — you always have something to work with. Pick exactly ONE of: (a) a reply to whichever single post (from the full input, not only the ones that made it into items) is most worth responding to, or (b) if truly nothing individually deserves a reply, a standalone post idea grounded in the general theme of what's in the input, with NO reference to any specific person, post, or account. Write real, specific, ready-to-send text — never a description of what a reply/post could say, and never a placeholder.",
    "- draft.text: 1-3 sentences, plain words. It should read like a knowledgeable person talking, not a lab statement or a press release.",
    "- " + buildFactInventionRule(),
    "- Never pitch or link-drop. No sycophancy (\"Great post!\"), no engagement-bait, no questions asked purely to farm replies.",
    "- These are mutually exclusive, not a spectrum: if the draft names a specific person, quotes them, paraphrases their specific point, or is otherwise clearly reacting to one identifiable post, it IS a reply — type must be \"reply\" with that post's url, and that post must appear in items so the reader can see what's being replied to. type \"post\" is ONLY for an idea that stands on its own with zero assumed context — the reader must be able to understand it without seeing any other tweet. Never write a \"post\" that name-drops someone or paraphrases their tweet; that's a reply wearing a post's label.",
    "- Also give that draft a one-sentence \"today's move\" framing: why this specific reply/post, out of everything in the digest, is the one worth acting on today.",
    "- items may end up empty (nothing cleared the bar for a full digest card) — that's fine. draft is a separate, independent requirement and is still mandatory even when items is empty.",
    "",
    "== OUTPUT ==",
    "Respond with ONLY a JSON object, no prose, no markdown fences:",
    '{"items": [{"url": "<url from input>", "summary": "<two-line summary>", "whyCare": "<one sentence>"}], "draft": {"type": "reply", "url": "<url of the item this replies to, must match one of the items above>", "why": "<one-sentence today\'s-move framing>", "text": "<the actual drafted reply>"} }',
    'Or, if a standalone post fits better than a reply to any single item: {"items": [...], "draft": {"type": "post", "why": "<one-sentence today\'s-move framing>", "text": "<the actual drafted post>"} }',
    "draft.url must always be one of the urls in items — if you want to reply to a post that didn't make the items list, add it to items too (a short summary/whyCare is easy to write for it).",
  ].join("\n");
}

function buildDigestUserContent(posts) {
  return (
    "Here are posts collected from my feed. Build the digest from these.\n\n" +
    JSON.stringify(
      posts.map((p) => ({
        url: p.url,
        author: p.author,
        handle: p.handle,
        text: p.text,
        engagement: p.engagement,
      })),
      null,
      2
    )
  );
}

// Stage-1 (map) prompt for batches larger than DIGEST_BATCH_SIZE — a cheap
// triage pass, not the full digest format, so each chunk stays fast. Only
// the url matters downstream; "reason" is scratch space for the model, not
// surfaced to the user.
function buildShortlistSystemPrompt(s) {
  return [
    "You are triaging a batch of social media posts for a later digest step — don't write the digest yet, just shortlist candidates.",
    "",
    "== WHAT THE DIGEST WILL LOOK FOR (in their own words) ==",
    s.digestFocus || "(No digest focus set. Default: unusual engagement, notable industry debates, and anything a competitor or well-known account announced.)",
    "",
    "== TASK ==",
    "From the posts below, pick up to 5 that are plausibly worth including in a digest based on the focus above. Skip engagement-bait, giveaways, and reply/quote-tweet farming outright.",
    "",
    "== OUTPUT ==",
    "Respond with ONLY a JSON array, no prose, no markdown fences:",
    '[{"url": "<url from input>", "reason": "<short phrase, for internal use only>"}]',
    "If nothing in this batch qualifies, return an empty array.",
  ].join("\n");
}

function parseShortlistResult(text) {
  const clean = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```json|```/g, "")
    .trim();
  try {
    const parsed = JSON.parse(clean);
    if (Array.isArray(parsed)) return parsed.filter((i) => i && i.url);
  } catch (_) {}
  const match = clean.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) return parsed.filter((i) => i && i.url);
    } catch (_) {}
  }
  return []; // a malformed shortlist batch just contributes nothing, not a hard failure
}

// validUrls is the set of real, DOM-scraped post URLs sent as input for this
// digest pass — never trust a url the model echoes back without checking it
// against that set first. A model response is attacker-influenceable (a
// crafted tweet attempting indirect prompt injection against the digest
// model), and an unvalidated url here would land straight in an <a href>/
// window.open() in content.js — a "javascript:" url there would execute in
// the real, authenticated x.com page. Fail closed: default to an empty set
// (rejects every url) rather than skipping the check if the caller forgets
// to pass one.
function parseDigestResult(text, validUrls = new Set()) {
  const clean = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```json|```/g, "")
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (_) {
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch (_) {}
    }
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Could not parse the model's digest response as JSON. Try again, or a stronger model.");
  }
  const items = Array.isArray(parsed.items)
    ? parsed.items.filter((i) => i && typeof i.url === "string" && validUrls.has(i.url))
    : [];

  let draft = null;
  const d = parsed.draft;
  if (d && typeof d === "object" && typeof d.text === "string" && d.text.trim()) {
    const why = typeof d.why === "string" ? d.why : "";
    if (d.type === "reply" && typeof d.url === "string" && items.some((i) => i.url === d.url)) {
      draft = { type: "reply", url: d.url, why, text: d.text };
    } else if (d.type === "post") {
      draft = { type: "post", why, text: d.text };
    }
  }

  return { items, draft };
}

// A "post" draft that names or paraphrases a specific person's post is
// actually a reply wearing a post's label — the model sometimes does this
// despite the prompt rule against it. Cheap heuristic: does the draft text
// contain any candidate's handle or display name?
function draftLeaksSpecificPost(draft, candidates) {
  if (!draft || draft.type !== "post" || !draft.text) return false;
  const text = draft.text.toLowerCase();
  return candidates.some((p) => {
    const handle = (p.handle || "").replace(/^@/, "").trim().toLowerCase();
    const author = (p.author || "").trim().toLowerCase();
    return (handle.length > 2 && text.includes(handle)) || (author.length > 2 && text.includes(author));
  });
}

// Backstop for the "never invent facts about your own team/process" rule in
// buildFactInventionRule() above -- the local model at low reasoning effort
// keeps violating it in slightly different words each time real output was
// checked (seen in practice: "our internal review process", "our
// event-driven services", "in my own work, we've used prompt-based
// retrieval... the engagement spike was measurable"). A prompt rule alone
// wasn't reliable enough, so this flags the SHAPE of the claim -- first-
// person ownership language about the user's own team/product/process --
// rather than trying to verify any specific claim is false. The underlying
// rule bans this category outright regardless of whether a given instance
// happens to be true, since the model has no way to know either way, so
// matching the shape is enough to justify a retry.
const OWN_WORK_CLAIM = /\b(in my own work|on my own team|our\s+(?:[\w-]+\s+){0,2}(?:team|process|pipeline|systems?|products?|services?|review|deploy\w*|infrastructure|codebase|stack)|we(?:'ve| have) (?:used|built|found|seen|shipped|deployed|cut|reduced|measured))\b/i;
function draftInventsOwnWork(draft) {
  return !!(draft && draft.text && OWN_WORK_CLAIM.test(draft.text));
}

// Loads the "already digested" url -> timestamp map, dropping anything older
// than DIGEST_HISTORY_DAYS so it doesn't grow forever or exclude things
// you'd reasonably want to see again after a few days.
async function loadPrunedDigestHistory() {
  const stored = await chrome.storage.local.get({ [DIGEST_HISTORY_KEY]: {} });
  const history = stored[DIGEST_HISTORY_KEY] || {};
  const cutoff = Date.now() - DIGEST_HISTORY_DAYS * 24 * 60 * 60 * 1000;
  const pruned = {};
  for (const [url, ts] of Object.entries(history)) {
    if (ts >= cutoff) pruned[url] = ts;
  }
  return pruned;
}

// Fire-and-forget progress ping to the content script so a multi-batch
// digest (which can take minutes on a local model) shows live progress
// instead of a frozen button — and, just as importantly, doubles as a
// heartbeat: content.js resets its own dead-worker timeout on every ping
// carrying this requestId, so if this service worker ever dies mid-digest
// (an MV3 risk even with the keepalive Port), the silence itself is what
// gets detected, instead of the UI hanging until a long last-resort timeout.
function reportDigestProgress(tabId, requestId, done, total) {
  pushToTab(tabId, { type: "DIGEST_PROGRESS", requestId, done, total });
}

async function shortlistChunk(s, chunk) {
  const systemPrompt = buildShortlistSystemPrompt(s);
  const userContent = buildDigestUserContent(chunk);
  const text = await callModel(s, systemPrompt, userContent, { maxTokens: 3500, reasoningEffort: "low" });
  return parseShortlistResult(text);
}

async function generateDigest(posts, requestId, tabId) {
  const s = await getSettings();
  if (!posts || posts.length === 0) {
    throw new Error("No posts found on screen. Scroll your feed for a bit first, then generate the digest.");
  }

  // Filtering already-seen posts out of the input (rather than just asking
  // the model nicely) guarantees no repeats and saves tokens either way.
  const history = await loadPrunedDigestHistory();
  const fresh = posts.filter((p) => p.url && !history[p.url]);
  if (fresh.length === 0) {
    return {
      items: [],
      draft: null,
      emptyMessage: "Nothing new since your last digest — everything currently on screen was already surfaced recently.",
    };
  }

  // Small pools skip straight to the full digest pass. Larger pools (this is
  // the point of scanning 100+ posts) go through a cheap map/reduce: shortlist
  // each chunk independently first, then run the full digest format only over
  // the merged, much smaller candidate set. Keeps every individual model call
  // a sane size instead of one huge request.
  let candidates = fresh;
  const preFiltered = fresh.length > DIGEST_BATCH_SIZE;
  if (preFiltered) {
    const chunks = [];
    for (let i = 0; i < fresh.length; i += DIGEST_BATCH_SIZE) {
      chunks.push(fresh.slice(i, i + DIGEST_BATCH_SIZE));
    }
    const byUrl = new Map(fresh.map((p) => [p.url, p]));
    const shortlisted = new Map();
    for (let i = 0; i < chunks.length; i++) {
      reportDigestProgress(tabId, requestId, i, chunks.length + 1); // +1 for the final reduce pass
      try {
        const picks = await shortlistChunk(s, chunks[i]);
        for (const pick of picks) {
          const post = byUrl.get(pick.url);
          if (post) shortlisted.set(pick.url, post);
        }
      } catch (_) {
        // one bad batch just contributes nothing — don't fail the whole digest over it
      }
    }
    candidates = Array.from(shortlisted.values());
    reportDigestProgress(tabId, requestId, chunks.length, chunks.length + 1);
    if (candidates.length === 0) {
      return { items: [], draft: null, emptyMessage: "Nothing stood out across the posts scanned." };
    }
  }

  const systemPrompt = buildDigestSystemPrompt(s, preFiltered);
  const userContent = buildDigestUserContent(candidates);
  // Formatting up to 8 items (url + summary + whyCare each, plus a drafted
  // reply/post) genuinely needs more room than the 2000-token default used
  // for compact per-post scoring JSON — observed truncating mid-response
  // (finish_reason "length") on real digests, which then fails to parse.
  const DIGEST_MAX_TOKENS = 3500;
  const validUrls = new Set(candidates.map((p) => p.url).filter(Boolean));
  const text = await callModel(s, systemPrompt, userContent, { maxTokens: DIGEST_MAX_TOKENS, reasoningEffort: "low" });
  let digest = parseDigestResult(text, validUrls);

  // The prompt mandates a draft whenever there's at least one candidate post
  // (which is guaranteed here), but local models occasionally drop it anyway,
  // mislabel a reply-in-disguise as a standalone "post" (naming/paraphrasing
  // a specific person without linking their tweet), or invent a specific
  // about the user's own team/work. One retry with a sharper, targeted nudge
  // is enough in practice — cheaper than shipping any of these three.
  const leaked = draftLeaksSpecificPost(digest.draft, candidates);
  const invents = draftInventsOwnWork(digest.draft);
  if (!digest.draft || leaked || invents) {
    try {
      const nudge = leaked
        ? "\n\nYour previous \"draft\" was type \"post\" but named or paraphrased a specific person's post — that makes it a reply, not a standalone post. Fix it: either set type to \"reply\" with that post's url (and add that post to items so it's visible), or rewrite it as a truly standalone idea with no reference to anyone specific."
        : invents
        ? "\n\nYour previous \"draft\" claimed something specific about your own team, product, or process (\"our own X\", \"we've used/built/found...\", \"in my own work...\"). You have no knowledge of the user's actual current work, so that claim is always a rule violation, true or not. Rewrite draft.text to engage with the post's own content and general expertise instead — zero claims about your own team, product, or process."
        : "\n\nYour previous response omitted \"draft\", which is mandatory. Re-read the draft rules above and include a real one this time — pick a reply or standalone post, it does not need to be perfect.";
      const retrySystemPrompt = systemPrompt + nudge;
      const retryText = await callModel(s, retrySystemPrompt, userContent, { maxTokens: DIGEST_MAX_TOKENS, reasoningEffort: "low" });
      const retryDigest = parseDigestResult(retryText, validUrls);
      const retryBad = draftLeaksSpecificPost(retryDigest.draft, candidates) || draftInventsOwnWork(retryDigest.draft);
      if (retryDigest.draft && !retryBad) {
        digest = {
          items: retryDigest.items.length ? retryDigest.items : digest.items,
          draft: retryDigest.draft,
        };
      } else if (leaked || invents) {
        digest = { items: digest.items, draft: null }; // still bad (or nothing usable) — drop it rather than ship it
      }
    } catch (_) {
      if (leaked || invents) digest = { items: digest.items, draft: null };
      // otherwise leave digest.draft null — better to show a digest without one than to fail it entirely
    }
  }

  const now = Date.now();
  for (const item of digest.items) {
    if (item.url) history[item.url] = now;
  }
  await chrome.storage.local.set({ [DIGEST_HISTORY_KEY]: history });

  return digest;
}

// Inert in the real extension (no `module` global in an MV3 service worker) —
// exposes the pure, chrome-API-free functions for unit testing under Node.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    parseResults,
    parseShortlistResult,
    parseDigestResult,
    draftLeaksSpecificPost,
    draftInventsOwnWork,
    isSettingsError,
    looksLikeGarbageOcr,
    extractOcrText,
    ocrPromptFor,
    buildVoiceAndTellsSection,
    buildSystemPrompt,
    buildDigestSystemPrompt,
    getSettings,
  };
}
