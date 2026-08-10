// Reply Scout — shared default persona.
//
// A worked EXAMPLE, not an opinion the extension holds — deliberately
// generic (a builder/founder sharing real work) rather than tied to any
// specific field, so the format/depth comes across without reading as
// someone else's actual persona. Meant to be fully replaced, not lightly
// edited.
//
// Single source of truth, loaded by two different contexts that can't
// share an ES module directly in this unbundled setup:
//   - background.js (MV3 service worker, classic script) via importScripts()
//     — this is what makes scoring/drafting actually work before Settings
//     has ever been opened, not just what the settings page displays.
//   - options.js (options page) via a plain <script src> tag before it.
// Also require()-able under Node for background.js's test suite.

const DEFAULT_THESIS = `Real, specific detail about what I'm building beats generic hot takes — the tradeoffs behind a decision, the numbers, what broke and how it got fixed. That's the bar every reply should clear. (This is an example — replace it with the one or two sentences you'd actually defend in every reply.)`;

const DEFAULT_RUBRIC = `Score each post 0-10 on reply-worthiness, weighing:

1. Thesis fit (most important). Does the post touch what I actually work on or care about — product decisions, technical tradeoffs, team/process lessons, the specific field I'm in?
2. Genuine value. Can I add something true and concrete from my own experience — a number, a technique, a mistake I made — not just agreement or cheerleading?
3. Reachability. Is the author's audience big enough to matter but small enough that a reply might actually get seen and responded to?
4. Freshness. Recent, active conversations beat old ones nobody's still reading.

Automatic low scores (0-3): generic hustle-culture platitudes, rage-bait, anything where the honest reply is nothing, posts where a reply would look like a pitch.

This is an example rubric — edit the specifics until it matches how you'd actually judge a post.`;

const DEFAULT_DIGEST_FOCUS = `I'm a builder who wants to know what's worth reading in ten minutes, not an hour of scrolling. Surface:
- Real product or technical lessons from people building things
- Notable launches, outages, or postmortems in my space
- Debates or takes worth having an opinion on
- Unusual traction on posts from people I follow

Skip generic motivational content, engagement-bait, and anything that's just hustle-culture noise.

This is an example digest focus — replace it with your own role and what's actually worth your ten minutes.`;

// Left blank deliberately, unlike the others — real writing samples are the
// whole point of voice matching (a fabricated "example voice" would just be
// a style the model imitates blindly, not a demonstration of anything
// useful). Scoring/drafting works fine without it; buildSystemPrompt falls
// back to plain, restrained sentences until real samples are added.
const DEFAULT_VOICE = "";

// Inert in a browser/worker context (no `module` global there) — lets this
// same file be require()'d directly under Node for background.js's tests.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { DEFAULT_THESIS, DEFAULT_RUBRIC, DEFAULT_DIGEST_FOCUS, DEFAULT_VOICE };
}
