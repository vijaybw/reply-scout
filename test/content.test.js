// content.js runs as an IIFE with real DOM/chrome dependencies throughout,
// so it can't be require()'d directly the way background.js can. isSafeXUrl
// is pure (just URL parsing, no DOM), so instead of duplicating its logic
// here — which would silently drift out of sync with the real source if
// content.js ever changed — this extracts the actual function body from the
// source file at test time and evaluates it. If the function is renamed or
// removed, the regex fails to match and the test errors loudly rather than
// silently testing a stale copy.
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
const match = source.match(/function isSafeXUrl\(url\) \{[\s\S]*?\n  \}/);
if (!match) {
  throw new Error("Could not find isSafeXUrl in content.js — did it get renamed or removed?");
}
// eslint-disable-next-line no-eval
const isSafeXUrl = (0, eval)(`(${match[0]})`);

const cases = [
  ["javascript:alert(1)", false, "javascript: scheme"],
  ["https://x.com/user/status/123", true, "real x.com status url"],
  ["https://twitter.com/user/status/123", true, "real twitter.com status url"],
  ["https://www.x.com/user/status/1", true, "www subdomain allowed"],
  ["http://x.com/user/status/123", false, "http (not https) rejected"],
  ["https://evil.com/x.com/status/123", false, "lookalike path, real hostname is evil.com"],
  ["https://x.com.evil.com/status/123", false, "hostname-suffix trick rejected"],
  ["https://xcom.evil.com/x.com/status/1", false, "another lookalike, unrelated hostname"],
  ["data:text/html,<script>alert(1)</script>", false, "data: scheme"],
  ["not a url at all", false, "malformed string"],
  [null, false, "null"],
  [undefined, false, "undefined"],
  [123, false, "non-string input"],
];

for (const [input, expected, label] of cases) {
  test(`isSafeXUrl: ${label}`, () => {
    assert.equal(isSafeXUrl(input), expected);
  });
}
