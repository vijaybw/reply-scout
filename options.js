// Reply Scout — options page logic

// These defaults are a worked EXAMPLE, not an opinion the extension holds —
// every new user sees this on first install, so it's deliberately generic
// (a builder/founder sharing real work) rather than tied to any specific
// field, so the format/depth comes across without reading as someone else's
// actual persona. Meant to be fully replaced, not lightly edited.
const DEFAULT_THESIS = `Real, specific detail about what I'm building beats generic hot takes — the tradeoffs behind a decision, the numbers, what broke and how it got fixed. That's the bar every reply should clear. (This is an example — replace it with the one or two sentences you'd actually defend in every reply.)`;

const DEFAULT_RUBRIC = `Score each post 0-10 on reply-worthiness, weighing:

1. Thesis fit (most important). Does the post touch what I actually work on or care about — product decisions, technical tradeoffs, team/process lessons, the specific field I'm in?
2. Genuine value. Can I add something true and concrete from my own experience — a number, a technique, a mistake I made — not just agreement or cheerleading?
3. Reachability. Is the author's audience big enough to matter but small enough that a reply might actually get seen and responded to?
4. Freshness. Recent, active conversations beat old ones nobody's still reading.

Automatic low scores (0-3): generic hustle-culture platitudes, rage-bait, anything where the honest reply is nothing, posts where a reply would look like a pitch.

This is an example rubric — edit the specifics until it matches how you'd actually judge a post.`;

const DEFAULT_VOICE = ``;

const DEFAULT_DIGEST_FOCUS = `I'm a builder who wants to know what's worth reading in ten minutes, not an hour of scrolling. Surface:
- Real product or technical lessons from people building things
- Notable launches, outages, or postmortems in my space
- Debates or takes worth having an opinion on
- Unusual traction on posts from people I follow

Skip generic motivational content, engagement-bait, and anything that's just hustle-culture noise.

This is an example digest focus — replace it with your own role and what's actually worth your ten minutes.`;

const FIELDS = ["provider", "apiKey", "localBaseUrl", "localModel", "localOcrModel", "thesis", "rubric", "voice", "minScore", "digestFocus", "digestPostTarget"];
const CHECKBOX_FIELDS = ["processImages", "warnLayoutChange"];

function toggleProviderCards() {
  const provider = document.getElementById("provider").value;
  document.getElementById("anthropicCard").style.display = provider === "anthropic" ? "" : "none";
  document.getElementById("localCard").style.display = provider === "local" ? "" : "none";
}

async function load() {
  const stored = await chrome.storage.local.get({
    provider: "anthropic",
    apiKey: "",
    localBaseUrl: "http://localhost:1234/v1",
    localModel: "",
    localOcrModel: "",
    thesis: DEFAULT_THESIS,
    rubric: DEFAULT_RUBRIC,
    voice: DEFAULT_VOICE,
    minScore: 6,
    processImages: false,
    warnLayoutChange: true,
    digestFocus: DEFAULT_DIGEST_FOCUS,
    digestPostTarget: 45,
  });
  for (const f of FIELDS) {
    document.getElementById(f).value = stored[f];
  }
  for (const f of CHECKBOX_FIELDS) {
    document.getElementById(f).checked = stored[f];
  }
  toggleProviderCards();
  loadDraftStats();
}

async function loadDraftStats() {
  const s = await chrome.storage.local.get({ draftedCount: 0, copiedCount: 0 });
  const el = document.getElementById("draftStats");
  if (s.draftedCount === 0) {
    el.textContent = "No drafts yet — this fills in as you use Reply Scout.";
    return;
  }
  const pct = Math.round((s.copiedCount / s.draftedCount) * 100);
  el.textContent = `${s.copiedCount} of ${s.draftedCount} drafted replies copied (${pct}%) — a rough signal of how well-calibrated your rubric is.`;
}

async function save() {
  const data = {};
  for (const f of FIELDS) {
    data[f] = document.getElementById(f).value;
  }
  for (const f of CHECKBOX_FIELDS) {
    data[f] = document.getElementById(f).checked;
  }
  data.minScore = parseFloat(data.minScore) || 6;
  data.digestPostTarget = Math.max(15, parseInt(data.digestPostTarget, 10) || 45);
  await chrome.storage.local.set(data);
  const status = document.getElementById("status");
  status.textContent = "Saved";
  setTimeout(() => (status.textContent = ""), 1800);
}

document.getElementById("save").addEventListener("click", save);
document.getElementById("provider").addEventListener("change", toggleProviderCards);
load();
