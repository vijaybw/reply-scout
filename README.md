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

1. Open one of your X **Lists** or a **saved search** (these are your monitoring feeds).
2. Scroll until a screenful of candidate posts is visible.
3. Click **Scan visible posts**. Up to 15 posts are scored per scan.
4. Review the results, sorted by score. For anything with a draft:
   - Edit the draft in the textarea — you are the last filter, always.
   - **Copy reply**, then **Open post** (or **Find on page**), and paste + post by hand.
5. Scroll further or switch feeds and scan again.

## Notes

- **Cost:** each scan is one small API call — typically a fraction of a cent. A heavy daily habit costs a few dollars a month.
- **Model:** uses `claude-sonnet-4-6`. You can change the `MODEL` constant in `background.js`.
- **Privacy:** your key and settings live in Chrome's local extension storage. Post text is sent only to api.anthropic.com for scoring.
- **X DOM changes:** X occasionally renames its internal markup. If scanning suddenly finds nothing, the selectors in `content.js` (`article[data-testid="tweet"]`, `[data-testid="tweetText"]`, `[data-testid="User-Name"]`) may need updating.
- **Stay hand-on-the-wheel:** the copy-only design is deliberate. Automated posting from a session is against X's rules and would undercut the whole point — replies only work when they're genuinely yours.

## Files

- `manifest.json` — extension config (Manifest V3)
- `content.js` / `content.css` — the on-page panel and post extraction
- `background.js` — the Claude API call and scoring prompt
- `options.html` / `options.js` — settings: API key, thesis, rubric, voice, score threshold
