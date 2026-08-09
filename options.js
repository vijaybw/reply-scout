// Reply Scout — options page logic

const DEFAULT_THESIS = `Widely accessible AI, made safe by engineering rather than absolutism. Open weights, open infrastructure, and open incident reports beat both indiscriminate release and closed labs — and the way to earn that openness is empirical work: monitoring, forensics, and post-training craft done carefully in public. (Edit this until it's the sentence you'd defend in every post.)`;

const DEFAULT_RUBRIC = `Score each post 0-10 on reply-worthiness, weighing:

1. Thesis fit (most important). The post touches AI safety policy vs. engineering, open weights/open-source AI, fine-tuning or post-training misuse risk, monitoring/forensics/auditing of models, incident transparency — or the broader engineering-craft side of the thesis: distributed systems and infra pain in ML training, API/abstraction design, reproducibility bugs, engineering leadership (small teams, on-call culture, hiring, build-vs-buy) — anywhere my thesis or expertise genuinely adds to the conversation.
2. Genuine value. I can add something true and useful from research/engineering experience: a technical distinction, a concrete methodology, a debugging war story, a correction of a common misconception about how these systems actually work. If the only possible reply is agreement, cheerleading, or a pitch, score low.
3. Reachability. The author is big enough that replies get seen, small enough to plausibly engage back. Mega-accounts with thousands of replies score lower; peers, researchers, engineers, and mid-size accounts score higher.
4. Audience match. Their readers include ML researchers, safety/policy people, engineers building on open models, infra/backend engineers, engineering leaders and hiring managers, or people shaping lab/regulatory decisions.
5. Freshness. Recent posts and rising conversations beat stale ones.

Automatic low scores (0-3): rage-bait and safety-doomer/accelerationist flame wars; anything where a reply would look promotional or like lab PR; policy takes with no engineering substance; generic hustle-culture leadership takes with no systems insight; posts where the honest reply is nothing.`;

const DEFAULT_VOICE = ``;

const DEFAULT_DIGEST_FOCUS = `I'm a research-lab founder/scientist and engineering leader. Surface professionally-relevant content only:
- AI safety, open weights/open-source models, fine-tuning misuse risk, monitoring/forensics/auditing, incident transparency
- Post-training, RLVR, agentic training, evals — the ML research side
- Distributed systems and infra pain in ML training, API/abstraction design, reproducibility bugs
- Engineering leadership: small teams, on-call culture, hiring, build-vs-buy, org design
- Unusual traction on any of the above from people I follow, or notable lab/competitor announcements

Skip general-interest content — jokes, life advice, unrelated science/culture stories — even if it's getting a lot of engagement from people you follow, unless it's genuinely relevant to the above.
Skip engagement-bait, giveaways, and anything that's just farming replies or quote-tweets.`;

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
