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
  };
  return chrome.storage.local.get(defaults);
}

function buildSystemPrompt(s) {
  return [
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
    "Only include a non-null reply when score >= " + (s.minScore ?? 6) + ".",
  ].join("\n");
}

function buildUserContent(posts) {
  return (
    "Score these posts. Return only the JSON array.\n\n" +
    JSON.stringify(
      posts.map((p) => ({
        id: p.id,
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

async function callLocal(s, systemPrompt, userContent) {
  // One retry with backoff: after a crash, LM Studio's JIT loader needs a few
  // seconds to bring the model back before the retry can succeed.
  try {
    return await callLocalOnce(s, systemPrompt, userContent);
  } catch (firstErr) {
    await sleep(6000);
    try {
      return await callLocalOnce(s, systemPrompt, userContent);
    } catch (secondErr) {
      throw new Error(String(secondErr.message || secondErr) + " (retried once after 6s)");
    }
  }
}

async function callLocalOnce(s, systemPrompt, userContent) {
  const base = (s.localBaseUrl || "http://localhost:1234/v1").replace(/\/+$/, "");
  let res;
  try {
    res = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: s.localModel || "local-model",
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
  const systemPrompt = buildSystemPrompt(s);
  const userContent = buildUserContent(posts);
  const text = s.provider === "local"
    ? await callLocal(s, systemPrompt, userContent)
    : await callAnthropic(s, systemPrompt, userContent);
  return parseResults(text);
}
