// Reply Scout — background service worker
// Receives a batch of posts from the content script, scores them with either
// the Claude API or a local LM Studio server (OpenAI-compatible), returns results.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-sonnet-4-6";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "SCORE_POSTS") {
    enqueue(() => scorePosts(msg.posts))
      .then((results) => sendResponse({ ok: true, results }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true; // keep the message channel open for the async response
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
    thesis: "",
    rubric: "",
    voice: "",
    minScore: 6,
    processImages: false,            // send each post's own photo/video thumbnail along with its text
    localOcrModel: "",               // optional: OCR-specialized local model id, used instead of vision on the main model
  };
  return chrome.storage.local.get(defaults);
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
    "== VOICE (write replies to sound like these samples; match their restraint) ==",
    s.voice || "(No voice samples set. Default to plain, short, declarative sentences. No hype words, no exclamation points, no emojis, no hashtags.)",
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
    "- Never invent facts, numbers, outcomes, or program details.",
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
  const res = await fetch(withImageSize(url, sizeName));
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
  return extractOcrText(raw);
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
  const res = await fetch(ANTHROPIC_URL, {
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
  });
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

async function callLocal(s, systemPrompt, userContent, modelOverride) {
  // One retry with backoff: after a crash, LM Studio's JIT loader needs a few
  // seconds to bring the model back before the retry can succeed.
  try {
    return await callLocalOnce(s, systemPrompt, userContent, modelOverride);
  } catch (firstErr) {
    if (NO_VISION_SUPPORT.test(String(firstErr.message || firstErr))) {
      throw new Error(
        String(firstErr.message || firstErr) +
        ' — turn off "Include images when scoring" in settings, or load a vision-capable model (e.g. Qwen2-VL, LLaVA) in LM Studio.'
      );
    }
    await sleep(6000);
    try {
      return await callLocalOnce(s, systemPrompt, userContent, modelOverride);
    } catch (secondErr) {
      throw new Error(String(secondErr.message || secondErr) + " (retried once after 6s)");
    }
  }
}

async function callLocalOnce(s, systemPrompt, userContent, modelOverride) {
  const base = (s.localBaseUrl || "http://localhost:1234/v1").replace(/\/+$/, "");
  let res;
  try {
    res = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelOverride || s.localModel || "local-model",
        temperature: 0.4,
        max_tokens: 2000,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
      }),
    });
  } catch (e) {
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
  const text = s.provider === "local"
    ? await callLocal(s, systemPrompt, userContent)
    : await callAnthropic(s, systemPrompt, userContent);
  return parseResults(text);
}
