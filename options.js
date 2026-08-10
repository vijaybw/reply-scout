// Reply Scout — options page logic
// DEFAULT_THESIS / DEFAULT_RUBRIC / DEFAULT_VOICE / DEFAULT_DIGEST_FOCUS
// come from defaults.js, loaded via <script src="defaults.js"> before this
// file in options.html — shared with background.js so the example persona
// is real functional behavior, not just placeholder text in this form.

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
