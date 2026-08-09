# Reply Scout

A small Chrome extension for x.com. It reads the posts currently on your screen, scores each one against your thesis and rubric using the Claude API, and drafts replies in your voice for the ones worth engaging. You edit, copy, and post by hand. It never posts, likes, or follows for you.

No X API needed — it only sees what your logged-in browser already renders.

## Install (2 minutes)

1. Unzip this folder somewhere permanent (Chrome loads it from disk, so don't delete it later).
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (toggle, top right).
4. Click **Load unpacked** and select the `reply-scout` folder.
5. Click the Reply Scout icon (or the Settings link in the panel) to open settings:
   - Paste your **Anthropic API key** (create one at console.anthropic.com → API keys).
   - Edit the prefilled **thesis** and **rubric** until they're truly yours.
   - Paste 3–8 real writing samples into **Voice samples** — this is what makes drafts sound like you instead of like AI.
6. Go to x.com. The panel appears top-right.

## Daily loop (~10 minutes)

1. Open **x.com/home** or one of your X **Lists** (these are your monitoring feeds — the panel only appears here).
2. Scroll until a screenful of candidate posts is visible.
3. Click **Scan visible posts**. Up to 15 posts are scored per scan.
4. Review the results, sorted by score. For anything with a draft:
   - Edit the draft in the textarea — you are the last filter, always.
   - **Copy reply**, then **Open post** (or **Find on page**), and paste + post by hand.
5. Scroll further or switch feeds and scan again.

## Morning digest (optional)

A separate, one-click feature answering a different question than reply-scoring: not "should I reply to this," but "what's actually worth reading right now."

1. Open `x.com/home` or a List.
2. Click **Generate digest** in the panel. The page scrolls itself, loading posts at a human-like pace, until it's collected ~120 or the feed runs out.
3. Once enough posts are in, get up to 8 items — link, two-line summary, why it matters — plus one suggested reply or post idea for today.

Configure what it looks for in settings → **Digest focus** (prefilled with a software-engineering-leader framing; edit it to match your own role and interests — it's your words, not a fixed rubric).

- **Manual only, never automatic.** It only starts when you click the button, and it only scrolls *your own already-open, logged-in tab* while you're there watching — no unattended scheduling, no stored credentials, no background scraping while you're away. Same "you're the one at the keyboard" property that makes the rest of Reply Scout low-risk, just automating the scroll motion itself. Auto-scan is automatically paused for the run (so it isn't competing with the digest for the same local-model queue) and resumes exactly as it was once the digest finishes.
- **Pulls in fresh posts first.** If X is showing a "Show N posts" prompt (new tweets that arrived while you were reading) it gets clicked automatically before scrolling down for older content, so the freshest posts are considered too — best-effort text match, not guaranteed to catch every case.
- **Scans in batches for larger pools.** With more than ~25 posts collected, it first shortlists candidates from each batch independently, then runs the full digest format only over the merged shortlist — keeps every individual model call a reasonable size instead of one huge request. Expect this to take a couple of minutes on a local model; the button shows live progress (posts loaded, then batch N/M) the whole time.
- **Separate pipeline from reply-scoring**: its own prompt, no image handling.
- **Skips repeats**: anything already surfaced in a digest within the last ~3 days is filtered out locally before it's even sent to the model, so you won't see the same item twice across mornings.
- **X only.** LinkedIn isn't supported — it's a different site with entirely different page structure, and would need its own content script built against its actual markup.

## Notes

- **Where it's active:** the panel only appears on `x.com/home` and individual List timelines (`x.com/i/lists/...`). It stays off on profile pages, single-post (`/status/...`) pages, search, and everywhere else — those aren't monitoring feeds.
- **Ads:** promoted posts are detected and skipped before they're ever sent for scoring.
- **Image alt text:** always on, free. If a post's photo has an author-provided alt/description, it's folded into the post's text before scoring — no image fetch, no cost, works with any model.
- **Images:** off by default. Turn on **Include images when scoring** in settings to also process each post's own photo or video thumbnail (not quoted-tweet or link-preview images) — useful for screenshot/chart-heavy posts. What happens next depends on provider:
  - **Anthropic:** the image is sent directly to Claude as part of the scoring request (full vision, bigger/slower request per scan).
  - **Local, no OCR model set:** the image is sent directly to whatever model is loaded — it must support vision itself (e.g. Qwen2-VL, LLaVA), or LM Studio will error.
  - **Local, with an OCR model set** (settings → "OCR model for images"): the image is transcribed first by that dedicated model, and the extracted text is folded into the post like alt text — your main scoring model stays text-only and never needs vision support. Two good options in LM Studio: `lmstudio-community/Qwen2-VL-2B-Instruct-GGUF` — small (~1.5–2GB), RAM-friendly, handles both text-in-image and general photos/memes; or `allenai/olmOCR-2-7B-1025` — heavier (~6GB), specialized for reading document/screenshot-style images, and automatically gets its own tuned prompt (any model id containing "olmocr" triggers it — everything else gets a simpler, general-purpose describe/transcribe prompt).
  - **Not every image gets processed, even with the setting on.** A post only spends a fetch/model call on its image when the post's own text is short (under ~40 characters) — a substantial caption already gives the scorer enough to work with, so re-describing the photo too adds cost for little value. Video poster frames are skipped entirely (a paused mid-video frame is a weak, often misleading signal). Each batch also processes at most 6 images, so one image-heavy batch can't stall a scan. The panel's status line shows how many posts in the session had images, so you can see how common they actually are in your feeds.
- **Cost:** each scan is one small API call — typically a fraction of a cent with images off. Turning images on adds noticeably more per scan, though the gating above keeps that bounded.
- **Model:** uses `claude-sonnet-4-6`. You can change the `MODEL` constant in `background.js`.
- **Choosing a local model (scoring/drafting):** reasoning models are a mixed bag here. Their hidden "thinking" step can quietly eat most of a response's token budget before it ever writes the actual answer — which shows up as truncated or empty responses, and as drafts that ignore your voice/rubric instructions not because the model disagrees with them, but because it never had room left to apply them. If the model you load exposes it, `background.js` sends `reasoning_effort: "low"` on every local scoring/digest call (harmless if the server ignores the field) plus a 3500-token budget as a backstop, which fixes this for models that support the parameter. A pairing that's tested well: **gpt-oss-20b** for scoring/drafting — fast, compliant with style rules, and it's not vision-capable, so pair it with an OCR model above if you want images processed.
- **Privacy:** your key and settings live in Chrome's local extension storage. Post text (and, if enabled, post images) is sent only to api.anthropic.com, or to your own local LM Studio server, for scoring.
- **X DOM changes:** X occasionally renames its internal markup. If scanning suddenly finds nothing, the selectors in `content.js` (`article[data-testid="tweet"]`, `[data-testid="tweetText"]`, `[data-testid="User-Name"]`) may need updating. With **Warn if X's layout seems to have changed** on (default), the panel surfaces this itself — if a scan on Home or a List keeps finding zero posts, it shows a warning instead of silently doing nothing. This is diagnostic only: nothing about scanning, ad-detection, or scoring behavior changes when it fires.
- **Reply context:** when X shows a "Replying to @user" line above a reply surfaced in a feed/list, it's captured and included — so the scorer isn't judging a reply blind to what it's actually responding to.
- **Backlog cap:** if local scoring can't keep up with how fast you're scrolling, the queue stops growing past 150 posts rather than piling up indefinitely — the status line shows "backlog full" when this kicks in, and unscored posts get reconsidered once it drains.
- **Dedup survives a reload:** recently-scored posts are remembered for ~2 days (not just for the current page load), so a refresh or reopened tab won't re-score — and re-pay for — the same posts.
- **Draft quality stat:** settings shows a running "N of M drafted replies copied" figure — a rough, free signal on whether your rubric is producing drafts you actually use.
- **Resilience:** all network requests (Anthropic, LM Studio, image fetches) time out rather than hanging forever, and the background worker stays alive for the duration of long local-model calls instead of risking Chrome suspending it mid-request. Scoring and digest results are delivered as independent messages, targeted at the specific tab that made the request, rather than a single long-lived callback or an untargeted broadcast — either of which could leave a result computed successfully in the background but never actually reach the panel. If the background worker ever dies mid-task despite all that (an MV3 risk that isn't fully preventable), an idle timeout — reset on every digest progress ping, so a genuinely-still-working multi-batch digest is never killed early — catches the silence and fails visibly instead of leaving the panel looking frozen.
- **Stay hand-on-the-wheel:** the copy-only design is deliberate. Automated posting from a session is against X's rules and would undercut the whole point — replies only work when they're genuinely yours.

## Files

- `manifest.json` — extension config (Manifest V3)
- `content.js` / `content.css` — the on-page panel and post extraction
- `background.js` — the Claude API call and scoring prompt
- `options.html` / `options.js` — settings: API key, thesis, rubric, voice, score threshold
