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

const FIELDS = ["provider", "apiKey", "localBaseUrl", "localModel", "thesis", "rubric", "voice", "minScore"];

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
    thesis: DEFAULT_THESIS,
    rubric: DEFAULT_RUBRIC,
    voice: DEFAULT_VOICE,
    minScore: 6,
  });
  for (const f of FIELDS) {
    document.getElementById(f).value = stored[f];
  }
  toggleProviderCards();
}

async function save() {
  const data = {};
  for (const f of FIELDS) {
    data[f] = document.getElementById(f).value;
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
