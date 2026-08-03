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
- **Privacy:** your key and settings live in Chrome's local extension storage. Post text (and, if enabled, post images) is sent only to api.anthropic.com, or to your own local LM Studio server, for scoring.
- **X DOM changes:** X occasionally renames its internal markup. If scanning suddenly finds nothing, the selectors in `content.js` (`article[data-testid="tweet"]`, `[data-testid="tweetText"]`, `[data-testid="User-Name"]`) may need updating.
- **Stay hand-on-the-wheel:** the copy-only design is deliberate. Automated posting from a session is against X's rules and would undercut the whole point — replies only work when they're genuinely yours.

## Files

- `manifest.json` — extension config (Manifest V3)
- `content.js` / `content.css` — the on-page panel and post extraction
- `background.js` — the Claude API call and scoring prompt
- `options.html` / `options.js` — settings: API key, thesis, rubric, voice, score threshold
