// Reply Scout — options page logic

const DEFAULT_THESIS = `Genuine research beats credentials theater. Working one-on-one with a mentor on a real research question — in AI or in healthcare — teaches more, and signals more, than any course or certificate. (Edit this until it's the sentence you'd defend in every post.)`;

const DEFAULT_RUBRIC = `Score each post 0-10 on reply-worthiness, weighing:

1. Thesis fit (most important). The post touches research experience, mentorship, breaking into AI or healthcare, admissions/career signaling, learning by doing vs. courses — anywhere my thesis genuinely adds to the conversation.
2. Genuine value. I can add something true and useful from experience: a distinction, a concrete step, a correction of a common myth. If the only possible reply is agreement or a pitch, score low.
3. Reachability. The author is big enough that replies get seen, small enough to plausibly engage back. Mega-accounts with thousands of replies score lower; peers and mid-size accounts score higher.
4. Audience match. Their readers include students, career-changers, or professionals who might want a research mentor — or people who influence those readers (parents, counselors, PIs, hiring managers).
5. Freshness. Recent posts and rising conversations beat stale ones.

Automatic low scores (0-3): rage-bait and drama; anything where a reply would look promotional; topics I have no real standing on; posts where the honest reply is nothing.`;

const DEFAULT_VOICE = ``;

const DEFAULT_DIGEST_FOCUS = `I'm a software engineering leader. Surface professionally-relevant content only:
- Unusual traction on software engineering / AI / tech topics from people I follow
- Conversations or debates relevant to software engineering
- Anything competitors or notable accounts announced

Skip general-interest content — jokes, life advice, unrelated science/culture stories — even if it's getting a lot of engagement from people you follow, unless it's genuinely tech/SWE relevant.
Skip engagement-bait, giveaways, and anything that's just farming replies or quote-tweets.`;

const FIELDS = ["provider", "apiKey", "localBaseUrl", "localModel", "localOcrModel", "thesis", "rubric", "voice", "minScore", "digestFocus"];
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
  await chrome.storage.local.set(data);
  const status = document.getElementById("status");
  status.textContent = "Saved";
  setTimeout(() => (status.textContent = ""), 1800);
}

document.getElementById("save").addEventListener("click", save);
document.getElementById("provider").addEventListener("change", toggleProviderCards);
load();
