// Stub the minimum chrome surface background.js touches at load time
// (top-level addListener calls) so it can be require()'d under plain Node.
// Everything under test here is pure logic with no chrome API calls, except
// getSettings() — storage.local.get is stubbed to mimic real chrome.storage
// behavior for empty storage: it just echoes back whatever defaults object
// it was passed, since nothing is actually stored.
global.chrome = {
  runtime: {
    onConnect: { addListener() {} },
    onMessage: { addListener() {} },
  },
  action: { onClicked: { addListener() {} } },
  storage: {
    local: {
      get(defaults) {
        return Promise.resolve({ ...defaults });
      },
    },
  },
};

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseResults,
  parseShortlistResult,
  parseDigestResult,
  draftLeaksSpecificPost,
  looksLikeGarbageOcr,
  buildSystemPrompt,
  buildDigestSystemPrompt,
  getSettings,
} = require("../background.js");
const { DEFAULT_THESIS, DEFAULT_RUBRIC, DEFAULT_DIGEST_FOCUS, DEFAULT_VOICE } = require("../defaults.js");

test("getSettings: falls back to the default persona when nothing is stored, so scoring works before Settings is ever opened", async () => {
  const s = await getSettings();
  assert.equal(s.thesis, DEFAULT_THESIS);
  assert.equal(s.rubric, DEFAULT_RUBRIC);
  assert.equal(s.digestFocus, DEFAULT_DIGEST_FOCUS);
  assert.equal(s.voice, DEFAULT_VOICE);
  // A real thesis/rubric feeding into the actual scoring prompt, not just present in isolation.
  const prompt = buildSystemPrompt(s, false, false);
  assert.match(prompt, /Real, specific detail about what I'm building/);
});

test("buildDigestSystemPrompt: includes the user's actual voice samples", () => {
  const s = { voice: "A distinctive sample sentence nobody else would write." };
  const prompt = buildDigestSystemPrompt(s, false);
  assert.match(prompt, /A distinctive sample sentence nobody else would write\./);
});

test("buildDigestSystemPrompt: includes the AI-tells guardrails", () => {
  const prompt = buildDigestSystemPrompt({}, false);
  assert.match(prompt, /AVOID THESE AI TELLS/);
  assert.match(prompt, /delve, tapestry/);
  assert.match(prompt, /Pronoun choice/);
});

test("buildSystemPrompt and buildDigestSystemPrompt: ban all-questions-no-stance replies", () => {
  // Regression for a real observed draft: three stacked questions, no
  // opinion or fact of its own anywhere -- caught the "take a position"
  // rule too loosely worded to flag it.
  const mainPrompt = buildSystemPrompt({}, false, false);
  const digestPrompt = buildDigestSystemPrompt({}, false);
  for (const prompt of [mainPrompt, digestPrompt]) {
    assert.match(prompt, /entirely questions, with no stance or fact/);
    assert.match(prompt, /[Nn]ever stack more than one question/);
  }
});

test("buildDigestSystemPrompt: does not blanket-ban 'we' (voice samples should govern pronoun choice)", () => {
  const prompt = buildDigestSystemPrompt({}, false);
  assert.doesNotMatch(prompt, /never "we"/);
});

test("buildDigestSystemPrompt: scopes voice/tells to draft.text, not item summaries", () => {
  const prompt = buildDigestSystemPrompt({}, false);
  assert.match(prompt, /apply ONLY to draft\.text/);
});

test("buildDigestSystemPrompt: forbids inventing facts about the user's own team/process", () => {
  const prompt = buildDigestSystemPrompt({}, false);
  assert.match(prompt, /Never invent facts, numbers, outcomes, or specifics about the user's own team/);
});

test("buildSystemPrompt: forbids inventing facts about the user's own team/process (parity with digest)", () => {
  // Regression: a real digest draft claimed "our event-driven services" out
  // of nowhere -- the same class of bug the digest prompt was already fixed
  // for once, except buildSystemPrompt still had the old, much weaker
  // one-liner ("Never invent facts, numbers, outcomes, or program details.")
  // that doesn't name the "our team/process" failure mode at all.
  const prompt = buildSystemPrompt({}, false, false);
  assert.match(prompt, /Never invent facts, numbers, outcomes, or specifics about the user's own team/);
});

test("buildSystemPrompt and buildDigestSystemPrompt: always ban hype words and exclamation points, not just when voice is unset", () => {
  // Regression: this instruction used to live only inside the empty-voice
  // fallback string, so it silently stopped applying once getSettings()
  // started returning a populated DEFAULT_VOICE -- a real draft used against
  // the default persona then came back with an exclamation point.
  const s = { voice: "Some real voice sample text." };
  const mainPrompt = buildSystemPrompt(s, false, false);
  const digestPrompt = buildDigestSystemPrompt(s, false);
  for (const prompt of [mainPrompt, digestPrompt]) {
    assert.match(prompt, /No hype words, no exclamation points, no emojis, no hashtags/);
  }
});

test("buildDigestSystemPrompt: forbids pitching, link-dropping, sycophancy, and engagement-bait", () => {
  const prompt = buildDigestSystemPrompt({}, false);
  assert.match(prompt, /Never pitch or link-drop/);
  assert.match(prompt, /No sycophancy/);
  assert.match(prompt, /engagement-bait/);
});

test("buildSystemPrompt: still includes voice samples and AI-tells after the shared-section refactor", () => {
  const s = { voice: "Another distinctive sample line." };
  const prompt = buildSystemPrompt(s, false, false);
  assert.match(prompt, /Another distinctive sample line\./);
  assert.match(prompt, /AVOID THESE AI TELLS/);
  assert.match(prompt, /delve, tapestry/);
});

test("buildSystemPrompt: falls back to the no-voice default when voice is unset", () => {
  const prompt = buildSystemPrompt({}, false, false);
  assert.match(prompt, /No voice samples set/);
});

test("parseResults: plain JSON array", () => {
  const out = parseResults('[{"id":"rs-1","score":7,"reason":"ok","reply":"hi"}]');
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "rs-1");
});

test("parseResults: markdown-fenced JSON", () => {
  const out = parseResults('```json\n[{"id":"rs-1","score":2,"reason":"no","reply":null}]\n```');
  assert.equal(out[0].score, 2);
});

test("parseResults: strips a <think> block before parsing", () => {
  const out = parseResults('<think>reasoning here</think>[{"id":"rs-1","score":5,"reason":"x","reply":null}]');
  assert.equal(out[0].id, "rs-1");
});

test("parseResults: extracts JSON array embedded in prose", () => {
  const out = parseResults('Sure, here you go:\n[{"id":"rs-1","score":5,"reason":"x","reply":null}]\nHope that helps.');
  assert.equal(out[0].id, "rs-1");
});

test("parseResults: throws on unparseable output", () => {
  assert.throws(() => parseResults("not json at all"));
});

test("parseShortlistResult: valid array of picks", () => {
  const out = parseShortlistResult('[{"url":"https://x.com/a/status/1","reason":"fits"}]');
  assert.equal(out.length, 1);
  assert.equal(out[0].url, "https://x.com/a/status/1");
});

test("parseShortlistResult: drops entries without a url", () => {
  const out = parseShortlistResult('[{"reason":"no url here"}, {"url":"https://x.com/a/status/1","reason":"ok"}]');
  assert.equal(out.length, 1);
});

test("parseShortlistResult: malformed input returns empty array, not a throw", () => {
  const out = parseShortlistResult("garbage, not json");
  assert.deepEqual(out, []);
});

test("parseDigestResult: keeps items whose url is in the valid set", () => {
  const validUrls = new Set(["https://x.com/a/status/1"]);
  const text = JSON.stringify({
    items: [{ url: "https://x.com/a/status/1", summary: "s", whyCare: "w" }],
    draft: { type: "reply", url: "https://x.com/a/status/1", why: "y", text: "reply text" },
  });
  const out = parseDigestResult(text, validUrls);
  assert.equal(out.items.length, 1);
  assert.equal(out.draft.type, "reply");
  assert.equal(out.draft.url, "https://x.com/a/status/1");
});

test("parseDigestResult: drops items whose url was never in the input (security)", () => {
  const validUrls = new Set(["https://x.com/a/status/1"]);
  const text = JSON.stringify({
    items: [
      { url: "https://x.com/a/status/1", summary: "real", whyCare: "w" },
      { url: "javascript:alert(1)", summary: "fabricated", whyCare: "w" },
    ],
    draft: null,
  });
  const out = parseDigestResult(text, validUrls);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].url, "https://x.com/a/status/1");
});

test("parseDigestResult: drops a reply draft whose url isn't a kept item", () => {
  const validUrls = new Set(["https://x.com/a/status/1"]);
  const text = JSON.stringify({
    items: [{ url: "https://x.com/a/status/1", summary: "s", whyCare: "w" }],
    // draft targets a url that never made it into items (not in validUrls at all)
    draft: { type: "reply", url: "https://x.com/b/status/2", why: "y", text: "reply text" },
  });
  const out = parseDigestResult(text, validUrls);
  assert.equal(out.draft, null);
});

test("parseDigestResult: defaults validUrls to empty set (fails closed) if omitted", () => {
  const text = JSON.stringify({
    items: [{ url: "https://x.com/a/status/1", summary: "s", whyCare: "w" }],
    draft: null,
  });
  const out = parseDigestResult(text);
  assert.equal(out.items.length, 0);
});

test("parseDigestResult: keeps a standalone post draft regardless of items", () => {
  const validUrls = new Set();
  const text = JSON.stringify({ items: [], draft: { type: "post", why: "y", text: "a standalone idea" } });
  const out = parseDigestResult(text, validUrls);
  assert.equal(out.draft.type, "post");
  assert.equal(out.draft.text, "a standalone idea");
});

test("parseDigestResult: missing draft parses as null, not a throw", () => {
  const out = parseDigestResult(JSON.stringify({ items: [] }), new Set());
  assert.equal(out.draft, null);
});

test("parseDigestResult: throws on unparseable output", () => {
  assert.throws(() => parseDigestResult("not json", new Set()));
});

test("draftLeaksSpecificPost: true when a 'post' draft names a candidate's handle", () => {
  const candidates = [{ handle: "@MikeBradleyAI", author: "Mike Bradley" }];
  const draft = { type: "post", text: "Mike Bradley's note that cloud AI is common underscores a gap." };
  assert.equal(draftLeaksSpecificPost(draft, candidates), true);
});

test("draftLeaksSpecificPost: true when a 'post' draft names a candidate's display name only", () => {
  const candidates = [{ handle: "@sys_infra", author: "Infra Notes" }];
  const draft = { type: "post", text: "Building on what Infra Notes said, reproducibility matters." };
  assert.equal(draftLeaksSpecificPost(draft, candidates), true);
});

test("draftLeaksSpecificPost: false for a genuinely standalone post", () => {
  const candidates = [{ handle: "@sys_infra", author: "Infra Notes" }];
  const draft = { type: "post", text: "Reproducibility bugs are the quiet cost of distributed training." };
  assert.equal(draftLeaksSpecificPost(draft, candidates), false);
});

test("draftLeaksSpecificPost: false for reply-type drafts (naming is expected there)", () => {
  const candidates = [{ handle: "@sys_infra", author: "Infra Notes" }];
  const draft = { type: "reply", url: "https://x.com/a/status/1", text: "Infra Notes, great point." };
  assert.equal(draftLeaksSpecificPost(draft, candidates), false);
});

test("draftLeaksSpecificPost: false when draft is null", () => {
  assert.equal(draftLeaksSpecificPost(null, []), false);
});

test("looksLikeGarbageOcr: true for coordinate-only grounding output", () => {
  assert.equal(looksLikeGarbageOcr("(21,9),(984,983)"), true);
});

test("looksLikeGarbageOcr: true for empty/whitespace text", () => {
  assert.equal(looksLikeGarbageOcr("   "), true);
});

test("looksLikeGarbageOcr: true when there are no real words", () => {
  assert.equal(looksLikeGarbageOcr("### --- ***"), true);
});

test("looksLikeGarbageOcr: false for genuine transcribed text", () => {
  assert.equal(looksLikeGarbageOcr("HAWK-HEADED PARROTS come say hello"), false);
});
