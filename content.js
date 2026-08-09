// Reply Scout — content script (v1.5)
// Auto-scan mode: watches the timeline as you scroll, batches new posts
// intelligently, skips ads, and never re-scores the same post twice.
// Only active on monitoring feeds (Home, Lists) — stays off on profile and
// status pages, where there's nothing to scan.
// Still copy-only: this extension never posts, likes, or follows for you.

(() => {
  if (window.__replyScoutLoaded) return;
  window.__replyScoutLoaded = true;

  // Fires whenever the extension is reloaded/updated while this tab's
  // content script is still attached — every pending chrome.storage/
  // chrome.runtime call in this now-orphaned script throws it. Harmless
  // (refreshing the tab loads the new script and everything works again),
  // but left unhandled it shows up as a scary uncaught error. Suppressed
  // here rather than fixed, since there's nothing to fix — the old context
  // really is gone.
  window.addEventListener("unhandledrejection", (event) => {
    const msg = String(event.reason?.message || event.reason || "");
    if (/Extension context invalidated/i.test(msg)) event.preventDefault();
  });

  // ---------- state ----------
  const seen = new Set();        // keys of posts already sent for scoring
  const pending = new Map();     // key -> post object waiting to be scored
  let inFlight = false;
  let autoScan = false;
  let debounceTimer = null;
  let scoredCount = 0;
  let adSkipCount = 0;
  let imagePostCount = 0;        // posts seen this session that had at least one photo/video
  let hideBelow = true;          // hide cards under the draft threshold
  let minScore = 6;              // mirrors "Draft replies at score >=" in settings
  let onMonitoringPage = isMonitoringPage();
  let warnLayoutChange = true;   // surface a warning if X's markup seems to have changed
  let emptyScanStreak = 0;       // consecutive scans finding zero tweet articles at all
  let digestInFlight = false;

  const BATCH_MAX = 10;          // posts per request (kind to local models)
  const BATCH_TRIGGER = 5;       // flush immediately once this many are queued
  const DEBOUNCE_MS = 2500;      // otherwise flush this long after scrolling settles
  const CARD_CAP = 60;           // max result cards kept in the panel
  const EMPTY_SCAN_STREAK_THRESHOLD = 3; // consecutive zero-article scans before warning
  const PENDING_CAP = 150;       // stop queuing new posts past this — bounds the backlog if scoring can't keep up with scroll speed

  // Was 120 — cut down given real-world local-model disconnect frequency:
  // digest processes chunks strictly sequentially (no parallelism), so every
  // extra chunk directly multiplies worst-case wait time when retries are
  // common. 45 keeps it to ~2 shortlist chunks + 1 reduce pass instead of ~5.
  const DIGEST_SCROLL_TARGET = 45;
  const DIGEST_SCROLL_MAX_STEPS = 60; // hard cap regardless of target, in case posts are sparse
  const DIGEST_SCROLL_STALL_LIMIT = 5; // stop early if this many consecutive steps add nothing new
  const DIGEST_SCROLL_STEP_DELAY = 1400; // ms between scroll steps — human-like pace, lets content load

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- page gating ----------
  // The panel only makes sense on feeds made of many posts to triage: Home
  // and individual Lists. Profile pages and single-post (/status) pages show
  // one person's or one post's context, not a monitoring feed.
  function isMonitoringPage() {
    const path = location.pathname;
    if (path === "/home") return true;
    if (/^\/i\/lists\/[^/]+\/?$/.test(path)) return true;
    return false;
  }

  function updatePageGate() {
    onMonitoringPage = isMonitoringPage();
    panel.classList.toggle("rs-page-hidden", !onMonitoringPage);
    if (!onMonitoringPage) {
      clearTimeout(debounceTimer);
    } else if (autoScan) {
      collectNewPosts();
    }
  }

  chrome.storage.local.get({ autoScan: false, hideBelow: true, minScore: 6, warnLayoutChange: true, theme: "" }).then((s) => {
    autoScan = s.autoScan;
    hideBelow = s.hideBelow;
    minScore = parseFloat(s.minScore) || 6;
    warnLayoutChange = s.warnLayoutChange;
    if (s.theme === "dark" || s.theme === "light") panel.setAttribute("data-theme", s.theme);
    updateAutoUI();
    updateFilterUI();
    updatePageGate();
  });

  // `seen` is otherwise reset on every real page load/navigation, which
  // means a reload could re-score (and re-pay for) posts already scored
  // minutes earlier. Persisting recently-scored keys survives that, without
  // growing forever — pruned to a short recent window on every load/save.
  const SCORED_HISTORY_KEY = "scoredHistory";
  const SCORED_HISTORY_DAYS = 2;

  function loadScoredHistory() {
    return chrome.storage.local.get({ [SCORED_HISTORY_KEY]: {} }).then((stored) => {
      const history = stored[SCORED_HISTORY_KEY] || {};
      const cutoff = Date.now() - SCORED_HISTORY_DAYS * 24 * 60 * 60 * 1000;
      const pruned = {};
      for (const [key, ts] of Object.entries(history)) {
        if (ts >= cutoff) pruned[key] = ts;
      }
      return pruned;
    });
  }

  function saveScoredKeys(keys) {
    loadScoredHistory().then((history) => {
      const now = Date.now();
      for (const k of keys) history[k] = now;
      chrome.storage.local.set({ [SCORED_HISTORY_KEY]: history });
    });
  }

  loadScoredHistory().then((history) => {
    Object.keys(history).forEach((k) => seen.add(k));
  });

  // scoredCount/adSkipCount/imagePostCount are the running totals shown in
  // the status line. Without persistence they live only in this page's JS
  // state, which can vanish without an actual manual "refresh" — Chrome
  // discarding a backgrounded tab under memory pressure, or reloading the
  // extension itself, both tear down and re-run this content script from
  // scratch, silently zeroing the visible counters. Time-bounded restore so
  // a tab left open for days doesn't show stale numbers as this session's.
  const SESSION_STATS_KEY = "rsSessionStats";
  const SESSION_STATS_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

  function saveSessionStats() {
    chrome.storage.local.set({
      [SESSION_STATS_KEY]: { scoredCount, adSkipCount, imagePostCount, updatedAt: Date.now() },
    });
  }

  chrome.storage.local.get({ [SESSION_STATS_KEY]: null }).then((stored) => {
    const saved = stored[SESSION_STATS_KEY];
    if (saved && Date.now() - saved.updatedAt < SESSION_STATS_MAX_AGE_MS) {
      scoredCount = saved.scoredCount || 0;
      adSkipCount = saved.adSkipCount || 0;
      imagePostCount = saved.imagePostCount || 0;
      updateStatusIdle();
    }
  });

  // Rough, persistent signal on rubric calibration — no way today to tell
  // whether the scorer's high-scoring drafts are actually any good. Copying
  // a draft is a real vote of "this was worth using"; comparing that against
  // how many got drafted at all is a cheap proxy, shown in settings.
  function incrementStat(key) {
    chrome.storage.local.get({ [key]: 0 }).then((s) => {
      chrome.storage.local.set({ [key]: (s[key] || 0) + 1 });
    });
  }

  // Keep settings in sync if the user changes them mid-session
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.minScore) {
      minScore = parseFloat(changes.minScore.newValue) || 6;
      updateFilterUI();
      applyFilter();
    }
    if (changes.warnLayoutChange) {
      warnLayoutChange = changes.warnLayoutChange.newValue;
      updateStatusIdle();
    }
  });

  // ---------- ad / promoted detection ----------
  function isAd(article) {
    // X wraps promoted tweets in a placementTracking cell — it's an ANCESTOR
    // of the article, not a descendant, so check both directions in case the
    // markup ever nests the other way.
    if (article.closest('[data-testid="placementTracking"]')) return true;
    if (article.querySelector('[data-testid="placementTracking"]')) return true;
    // Belt-and-suspenders: the visible "Ad"/"Promoted" label, in whichever
    // element X currently renders it as (span text or an aria-label on the icon).
    const spans = article.querySelectorAll("span");
    for (const s of spans) {
      const t = s.textContent.trim();
      if (t === "Ad" || t === "Promoted") return true;
    }
    if (article.querySelector('[aria-label="Ad"], [aria-label="Promoted"]')) return true;
    return false;
  }

  // ---------- post extraction ----------
  function postKey(p) {
    return p.url || p.handle + "::" + p.text.slice(0, 80);
  }

  const IMAGE_CAP = 2; // per post — bounds request size/cost

  // Filters out the generic "Image" placeholder X sometimes sets when no
  // real alt text was provided, so we don't treat it as genuine content.
  function cleanAlt(raw) {
    const t = (raw || "").trim();
    if (!t || /^image$/i.test(t)) return "";
    return t;
  }

  // Only the post's own attached media — not the quoted-tweet's nested
  // article, not link-preview card thumbnails, not avatars or emoji.
  // Sizing/rendition selection happens in background.js at fetch time, since
  // that's where the rest of the provider-specific request shaping lives.
  // `kind` lets background.js skip video poster frames when deciding what's
  // worth an OCR/vision call — a paused mid-video frame is a weaker, often
  // misleading signal compared to a deliberately posted photo.
  function extractImages(article) {
    const images = [];
    const photoEls = article.querySelectorAll('[data-testid="tweetPhoto"] img');
    for (const img of photoEls) {
      if (images.length >= IMAGE_CAP) break;
      // Quote-tweets render as a nested <article>; closest("article") walks
      // up to that nested one instead of ours, so we can tell them apart.
      if (img.closest("article") !== article) continue;
      if (img.src) images.push({ url: img.src, alt: cleanAlt(img.alt), kind: "photo" });
    }
    if (images.length < IMAGE_CAP) {
      const video = article.querySelector('[data-testid="videoPlayer"] video[poster]');
      if (video && video.poster && video.closest("article") === article) {
        images.push({ url: video.poster, alt: "", kind: "video" });
      }
    }
    return images.slice(0, IMAGE_CAP);
  }

  // X shows a "Replying to @user" line above a reply's own text when it
  // surfaces one in a feed/list — without it, the scorer judges a reply
  // blind to what it's actually responding to. Text-pattern match rather
  // than a specific testid, since this hasn't been confirmed against live
  // markup — best-effort, not guaranteed to hit every case.
  function extractReplyContext(article) {
    const candidates = article.querySelectorAll("div, span, a");
    for (const el of candidates) {
      const t = (el.textContent || "").trim();
      if (t.length > 0 && t.length < 200 && /^replying to\b/i.test(t)) return t;
    }
    return "";
  }

  function extractArticle(article) {
    const textEl = article.querySelector('[data-testid="tweetText"]');
    const rawText = textEl ? textEl.innerText.trim() : "";
    if (!rawText) return null;
    const replyContext = extractReplyContext(article);
    const text = replyContext ? `[${replyContext}]\n${rawText}` : rawText;

    let author = "", handle = "";
    const userNameEl = article.querySelector('[data-testid="User-Name"]');
    if (userNameEl) {
      const lines = userNameEl.innerText.split("\n").map((s) => s.trim()).filter(Boolean);
      author = lines[0] || "";
      handle = lines.find((l) => l.startsWith("@")) || "";
    }

    let url = "";
    const timeEl = article.querySelector("a[href*='/status/'] time");
    if (timeEl && timeEl.parentElement && timeEl.parentElement.href) {
      url = timeEl.parentElement.href;
    } else {
      const linkEl = article.querySelector("a[href*='/status/']");
      if (linkEl) url = linkEl.href;
    }

    const engagement = {};
    article.querySelectorAll('button[data-testid="reply"], button[data-testid="retweet"], button[data-testid="like"]').forEach((btn) => {
      const label = btn.getAttribute("aria-label") || "";
      const num = (label.match(/[\d,.]+/) || ["0"])[0];
      if (btn.dataset.testid === "reply") engagement.replies = num;
      if (btn.dataset.testid === "retweet") engagement.reposts = num;
      if (btn.dataset.testid === "like") engagement.likes = num;
    });

    const images = extractImages(article);

    return { author, handle, text: text.slice(0, 1000), url, engagement, images, _article: article };
  }

  function collectNewPosts() {
    if (!onMonitoringPage) return 0;
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    // Zero tweet articles found on a page we know should have them is the
    // signature of X renaming its internal markup — track it as a streak so
    // one transient empty moment (mid-render, mid-navigation) doesn't false-alarm.
    emptyScanStreak = articles.length === 0 ? emptyScanStreak + 1 : 0;
    let added = 0;
    let adsSkippedThisScan = false;
    for (const article of articles) {
      if (article.dataset.replyScoutSeen) continue;
      const p = extractArticle(article);
      if (!p) { article.dataset.replyScoutSeen = "1"; continue; }
      const key = postKey(p);
      if (seen.has(key) || pending.has(key)) { article.dataset.replyScoutSeen = "1"; continue; }
      if (isAd(article)) {
        article.dataset.replyScoutSeen = "1";
        adSkipCount++;
        adsSkippedThisScan = true;
        continue;
      }
      // Backlog full — local scoring throughput can't keep up with scroll
      // speed. Don't mark seen: leave it to be picked up once the queue
      // drains, rather than growing pending without bound.
      if (pending.size >= PENDING_CAP) break;
      p.id = "rs-" + Math.random().toString(36).slice(2, 10);
      article.dataset.replyScoutId = p.id;
      article.dataset.replyScoutSeen = "1";
      if (p.images && p.images.length > 0) imagePostCount++;
      pending.set(key, p);
      added++;
    }
    if (added > 0 || adsSkippedThisScan) saveSessionStats();
    if (added > 0) scheduleFlush();
    updateStatusIdle();
    return added;
  }

  // ---------- batching ----------
  function scheduleFlush() {
    if (!autoScan) return;
    if (pending.size >= BATCH_TRIGGER) {
      flush();
      return;
    }
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, DEBOUNCE_MS);
  }

  function takeBatch() {
    const batch = [];
    for (const [key, p] of pending) {
      batch.push(p);
      pending.delete(key);
      seen.add(key);
      if (batch.length >= BATCH_MAX) break;
    }
    return batch;
  }

  // Long-running requests (a multi-batch digest can take several minutes)
  // don't wait on a single chrome.runtime sendResponse callback — that
  // message channel has its own lifetime independent of the service worker
  // process, and can close before a slow response arrives ("message channel
  // closed before a response was received"). Instead, background.js pushes
  // the result back as its own message once ready, correlated by requestId.
  // The keepalive Port is a separate, additional measure — it keeps the
  // service worker process itself alive for the underlying fetch, which the
  // requestId/push pattern alone doesn't guarantee.
  //
  // But that push can itself go missing: if the background service worker
  // dies mid-task (an MV3 risk even with the keepalive Port — Chrome can
  // still tear it down), everything in flight is silently abandoned. No
  // error, no response — just permanent silence, since nothing survives to
  // push a result back. A single long fixed timeout would either fire too
  // early (killing a legitimately slow multi-batch digest) or too late
  // (leaving the UI looking frozen for many minutes before giving up). So
  // instead this is an IDLE timeout that resets on every sign of life —
  // DIGEST_PROGRESS pings during a multi-batch run — rather than a fixed
  // ceiling from the start. A digest that's still genuinely working keeps
  // resetting it indefinitely; one whose worker died goes quiet and gets
  // caught within one idle window instead of the old 20-minute worst case.
  // SCORE_POSTS has no progress pings at all (only digest does), so this
  // base window is the only thing bounding it — it must comfortably exceed
  // its own legitimate worst case: LOCAL_TIMEOUT_MS (180s) on the first
  // attempt, +6s retry wait, +another full LOCAL_TIMEOUT_MS if the retry
  // also times out ≈ 366s. 7 minutes leaves real margin above that.
  const IDLE_TIMEOUT_MS = 420_000; // 7 minutes of silence = assume the worker died
  const pendingRequests = new Map(); // requestId -> resolve function
  const heartbeats = new Map();      // requestId -> reset-the-idle-timer function

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "SCORE_RESULT" || msg.type === "DIGEST_RESULT") {
      const resolve = pendingRequests.get(msg.requestId);
      if (resolve) {
        pendingRequests.delete(msg.requestId);
        resolve(msg);
      }
    }
    if (msg.type === "DIGEST_PROGRESS") {
      heartbeats.get(msg.requestId)?.();
    }
  });

  function sendLongRunning(type, payload) {
    return new Promise((resolve) => {
      const requestId = "req-" + Math.random().toString(36).slice(2);
      const port = chrome.runtime.connect({ name: "keepalive" });
      // A merely-open port isn't reliably enough to stop Chrome's idle
      // detector from tearing down the service worker mid-fetch — real
      // traffic crossing it is a much stronger "still in use" signal than
      // just holding the connection open and hoping.
      const pingInterval = setInterval(() => {
        try { port.postMessage({ type: "ping" }); } catch (_) {}
      }, 15000);
      let timer;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearInterval(pingInterval);
        clearTimeout(timer);
        heartbeats.delete(requestId);
        pendingRequests.delete(requestId);
        port.disconnect();
        resolve(result);
      };
      // If Chrome kills the background service worker mid-request (it can,
      // even with this keepalive Port open, especially under memory
      // pressure) the OTHER end of the port fires onDisconnect here. That's
      // very likely what LM Studio's own "Client disconnected" logs are
      // actually reporting — our fetch connection vanishing when its worker
      // died, not LM Studio itself crashing. Fail fast instead of silently
      // waiting out the full idle timeout for a response that can now never
      // arrive.
      port.onDisconnect.addListener(() => {
        finish({
          ok: false,
          error: "The background service worker was terminated mid-request. Try again — if this keeps happening, try closing other memory-heavy apps/tabs.",
        });
      });
      const resetIdleTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(
          () => finish({ ok: false, error: "The background worker went quiet mid-request — it may have been interrupted. Try again." }),
          IDLE_TIMEOUT_MS
        );
      };
      resetIdleTimer();
      heartbeats.set(requestId, resetIdleTimer);
      pendingRequests.set(requestId, finish);
      chrome.runtime.sendMessage({ type, requestId, ...payload });
    });
  }

  function flush() {
    clearTimeout(debounceTimer);
    if (inFlight || pending.size === 0) return;
    const batch = takeBatch();
    inFlight = true;
    setStatus(`Scoring ${batch.length} post${batch.length === 1 ? "" : "s"}… (${pending.size} queued)`, "busy");

    const payload = batch.map(({ _article, ...rest }) => rest);
    sendLongRunning("SCORE_POSTS", { posts: payload }).then((resp) => {
      inFlight = false;
      if (!resp || !resp.ok) {
        setStatus(resp ? resp.error : "No response from background worker.", "warn");
        // Put the batch back so it isn't silently lost on a transient failure
        batch.forEach((p) => { const k = postKey(p); seen.delete(k); pending.set(k, p); });
        return;
      }
      scoredCount += batch.length;
      saveScoredKeys(batch.map((p) => postKey(p)));
      saveSessionStats();
      renderResults(batch, resp.results, /*append*/ true);
      // More queued? keep going after a breather (local model is serial)
      if (autoScan && pending.size > 0) setTimeout(flush, 500);
      else updateStatusIdle();
    });
  }

  // ---------- panel UI ----------
  const panel = document.createElement("div");
  panel.id = "reply-scout-panel";
  panel.classList.toggle("rs-page-hidden", !onMonitoringPage);
  panel.innerHTML = `
    <div class="rs-header">
      <span class="rs-title">Reply Scout</span>
      <span class="rs-header-actions">
        <button class="rs-icon-btn" id="rs-theme" title="Toggle dark mode">
          <svg class="rs-i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          <svg class="rs-i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
        </button>
        <button class="rs-linklike" id="rs-settings" title="Open settings">Settings</button>
        <button class="rs-linklike" id="rs-collapse" title="Collapse">–</button>
      </span>
    </div>
    <div class="rs-body">
      <label class="rs-toggle-row">
        <input type="checkbox" id="rs-auto" />
        <span>Auto-scan as I scroll</span>
      </label>
      <label class="rs-toggle-row">
        <input type="checkbox" id="rs-hide" />
        <span id="rs-hide-label">Hide posts under score 6</span>
      </label>
      <button id="rs-scan" class="rs-scan">Scan visible posts</button>
      <button id="rs-digest-btn" class="rs-scan rs-scan-quiet">Generate digest</button>
      <div id="rs-status" class="rs-status">Nothing is ever posted for you. Ads are skipped automatically.</div>
      <div id="rs-digest" class="rs-digest"></div>
      <div id="rs-results" class="rs-results"></div>
    </div>
  `;
  document.documentElement.appendChild(panel);

  const scanBtn = panel.querySelector("#rs-scan");
  const digestBtn = panel.querySelector("#rs-digest-btn");
  const digestEl = panel.querySelector("#rs-digest");
  const statusEl = panel.querySelector("#rs-status");
  const resultsEl = panel.querySelector("#rs-results");
  const autoToggle = panel.querySelector("#rs-auto");

  panel.querySelector("#rs-theme").addEventListener("click", () => {
    const isDark = panel.getAttribute("data-theme") === "dark"
      || (!panel.getAttribute("data-theme") && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const next = isDark ? "light" : "dark";
    panel.setAttribute("data-theme", next);
    chrome.storage.local.set({ theme: next });
  });

  panel.querySelector("#rs-settings").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
  });
  panel.querySelector("#rs-collapse").addEventListener("click", () => {
    panel.classList.toggle("rs-collapsed");
    panel.querySelector("#rs-collapse").textContent = panel.classList.contains("rs-collapsed") ? "+" : "–";
  });

  const hideToggle = panel.querySelector("#rs-hide");
  hideToggle.addEventListener("change", () => {
    hideBelow = hideToggle.checked;
    chrome.storage.local.set({ hideBelow });
    applyFilter();
  });

  function updateFilterUI() {
    hideToggle.checked = hideBelow;
    panel.querySelector("#rs-hide-label").textContent =
      "Hide posts under score " + minScore;
  }

  function applyFilter() {
    let hidden = 0;
    resultsEl.querySelectorAll(".rs-card").forEach((card) => {
      const s = parseFloat(card.dataset.score || "0");
      const hide = hideBelow && s < minScore;
      card.classList.toggle("rs-card-filtered", hide);
      if (hide) hidden++;
    });
    resultsEl.classList.toggle("rs-has-hidden", hidden > 0);
  }

  autoToggle.addEventListener("change", () => {
    autoScan = autoToggle.checked;
    chrome.storage.local.set({ autoScan });
    updateAutoUI();
    if (autoScan) {
      collectNewPosts();
    } else {
      clearTimeout(debounceTimer);
      updateStatusIdle();
    }
  });

  function updateAutoUI() {
    autoToggle.checked = autoScan;
    scanBtn.style.display = autoScan ? "none" : "";
    updateStatusIdle();
  }

  scanBtn.addEventListener("click", () => {
    const added = collectNewPosts();
    if (warnLayoutChange && emptyScanStreak >= EMPTY_SCAN_STREAK_THRESHOLD) {
      setStatus(
        `Found 0 posts on screen — X's layout may have changed. Everything still works as before; the selectors in content.js may just need updating.`,
        "warn"
      );
      return;
    }
    if (pending.size === 0 && added === 0) {
      setStatus("No new posts on screen — everything visible is already scored or an ad.", "warn");
      return;
    }
    flushManual();
  });

  function flushManual() {
    // Manual mode uses the same queue but flushes regardless of autoScan
    if (inFlight) { setStatus("Still scoring the previous batch…", "busy"); return; }
    const wasAuto = autoScan;
    autoScan = true; flush(); autoScan = wasAuto;
  }

  // ---------- digest ----------
  // A separate, manually-triggered action — not part of the auto-scan/reply-
  // scoring pipeline, and never touches `seen`/`pending`.
  //
  // Auto-scrolls the page to load enough posts for a real digest (X only
  // renders what's visible plus a little buffer — a proper digest needs
  // 100+). This scrolls *your own already-open, logged-in tab*, only because
  // *you* clicked the button, at a human-like pace (~1.4s between steps) —
  // not an unattended background process. Collection happens incrementally
  // during each step, not just at the end, because X virtualizes old tweets
  // out of the DOM as you scroll past them — waiting until the end would
  // lose everything from earlier in the scroll.
  // X sometimes gates fresh content behind a "Show N posts" pill instead of
  // loading it via scroll (new tweets that arrived while you were reading).
  // Text-pattern match rather than a specific selector, since this hasn't
  // been confirmed against live markup — best-effort, not guaranteed to hit.
  function clickShowNewPostsButton() {
    const candidates = document.querySelectorAll('div[role="button"], span, a');
    for (const el of candidates) {
      const t = (el.textContent || "").trim();
      if (/^show\s+\d+\s+posts?$/i.test(t)) {
        (el.closest('[role="button"]') || el).click();
        return true;
      }
    }
    return false;
  }

  async function autoScrollAndCollect(onProgress) {
    const collected = new Map(); // url -> post, dedup across the whole scroll
    let stall = 0;
    for (let step = 0; step < DIGEST_SCROLL_MAX_STEPS; step++) {
      if (clickShowNewPostsButton()) await sleep(500); // let the freshly-injected posts render
      const before = collected.size;
      document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
        if (isAd(article)) return;
        const p = extractArticle(article);
        if (!p || !p.url || collected.has(p.url)) return;
        const { _article, images, ...rest } = p;
        collected.set(p.url, rest);
      });
      onProgress(collected.size);

      if (collected.size >= DIGEST_SCROLL_TARGET) break;
      stall = collected.size > before ? 0 : stall + 1;
      if (stall >= DIGEST_SCROLL_STALL_LIMIT) break; // feed's exhausted or not loading more — stop rather than spin

      window.scrollBy(0, Math.round(window.innerHeight * 0.85));
      await sleep(DIGEST_SCROLL_STEP_DELAY);
    }
    return Array.from(collected.values());
  }

  function renderDigest(digest, sourcePosts) {
    const byUrl = new Map(sourcePosts.map((p) => [p.url, p]));
    digestEl.innerHTML = "";
    const frag = document.createDocumentFragment();

    if (digest.items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "rs-digest-empty";
      empty.textContent = digest.emptyMessage || "Nothing new stood out from what's currently on screen.";
      frag.appendChild(empty);
    }

    digest.items.forEach((item) => {
      const src = byUrl.get(item.url);
      const card = document.createElement("div");
      card.className = "rs-digest-item";
      card.innerHTML = `
        <div class="rs-digest-top">
          <a class="rs-digest-link" target="_blank" rel="noopener">Open post</a>
          <span class="rs-digest-author"></span>
        </div>
        <div class="rs-digest-summary"></div>
        <div class="rs-digest-whycare"></div>
      `;
      card.querySelector(".rs-digest-link").href = item.url;
      card.querySelector(".rs-digest-author").textContent = src ? `${src.author} ${src.handle}`.trim() : "";
      card.querySelector(".rs-digest-summary").textContent = item.summary || "";
      if (item.whyCare) card.querySelector(".rs-digest-whycare").textContent = `Why it matters: ${item.whyCare}`;
      frag.appendChild(card);
    });

    if (digest.draft) {
      const isReply = digest.draft.type === "reply";
      const src = isReply ? byUrl.get(digest.draft.url) : null;

      const card = document.createElement("div");
      card.className = "rs-digest-suggestion";

      const label = document.createElement("strong");
      label.className = "rs-digest-suggestion-label";
      label.textContent = isReply
        ? `Reply worth sending${src ? ` — to ${src.author} ${src.handle}`.trim() : ""}`
        : "A post worth sending today";
      card.appendChild(label);

      const ta = document.createElement("textarea");
      ta.className = "rs-reply";
      ta.readOnly = true;
      ta.rows = 3;
      ta.value = digest.draft.text;
      card.appendChild(ta);

      const row = document.createElement("div");
      row.className = "rs-actions";

      const copyBtn = document.createElement("button");
      copyBtn.className = "rs-btn";
      copyBtn.textContent = "Copy";
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(ta.value).then(() => {
          copyBtn.textContent = "Copied";
          setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
        });
      });
      row.appendChild(copyBtn);

      if (isReply && digest.draft.url) {
        const openBtn = document.createElement("button");
        openBtn.className = "rs-btn rs-btn-quiet";
        openBtn.textContent = "Open post";
        openBtn.addEventListener("click", () => window.open(digest.draft.url, "_blank"));
        row.appendChild(openBtn);
      }
      card.appendChild(row);

      frag.appendChild(card);
    }

    digestEl.appendChild(frag);
  }

  // Progress pings from background.js during the multi-batch reduce pass
  // (see reportDigestProgress in background.js) — best-effort UI only.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "DIGEST_PROGRESS" && digestInFlight) {
      digestBtn.textContent = `Generating digest… batch ${msg.done}/${msg.total}`;
    }
  });

  digestBtn.addEventListener("click", async () => {
    if (digestInFlight) return;
    digestInFlight = true;
    digestBtn.disabled = true;
    digestBtn.textContent = "Loading posts… 0/" + DIGEST_SCROLL_TARGET;

    // Auto-scan's own MutationObserver reacts to every tweet our scrolling
    // reveals, queuing unrelated scoring requests that compete with the
    // digest's own batches in the same single-flight queue (background.js
    // serializes all local-model calls to avoid overloading it). Pause it
    // for the run, restored to exactly what it was before either way below.
    const wasAutoScan = autoScan;
    if (wasAutoScan) {
      autoScan = false;
      autoToggle.checked = false;
      autoToggle.disabled = true;
    }
    const restoreAutoScan = () => {
      if (wasAutoScan) {
        autoScan = true;
        autoToggle.checked = true;
        autoToggle.disabled = false;
        collectNewPosts();
      }
    };

    const posts = await autoScrollAndCollect((count) => {
      digestBtn.textContent = `Loading posts… ${count}/${DIGEST_SCROLL_TARGET}`;
    });

    if (posts.length === 0) {
      digestInFlight = false;
      digestBtn.disabled = false;
      digestBtn.textContent = "Generate digest";
      setStatus("No posts found to digest.", "warn");
      restoreAutoScan();
      return;
    }

    digestBtn.textContent = `Generating digest… (${posts.length} posts)`;
    sendLongRunning("GENERATE_DIGEST", { posts }).then((resp) => {
      digestInFlight = false;
      digestBtn.disabled = false;
      digestBtn.textContent = "Generate digest";
      restoreAutoScan();
      if (!resp || !resp.ok) {
        setStatus(resp ? resp.error : "No response from background worker.", "warn");
        return;
      }
      renderDigest(resp.digest, posts);
    });
  });

  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = "rs-status" + (kind ? " rs-" + kind : "");
  }

  function updateStatusIdle() {
    // Keep the queue count live even mid-flight — local models can take
    // 20-45s+ per batch, and posts keep piling up in `pending` as you
    // scroll during that wait. Bailing out here used to freeze the display
    // until the next flush snapshotted whatever pending had ballooned to.
    if (inFlight) {
      const q = pending.size > 0 ? ` · ${pending.size} more queued` : "";
      setStatus(`Scoring…${q}`, "busy");
      return;
    }
    // Diagnostic only — nothing about scanning, ad-detection, or hiding
    // behavior changes here. This just tells you something might be off
    // instead of leaving you wondering why nothing's showing up.
    if (warnLayoutChange && autoScan && emptyScanStreak >= EMPTY_SCAN_STREAK_THRESHOLD) {
      setStatus(
        `No posts detected across ${emptyScanStreak} scans — X's layout may have changed. Everything still works as before; the selectors in content.js may just need updating.`,
        "warn"
      );
      return;
    }
    const seenTotal = scoredCount + pending.size;
    const imgPct = seenTotal > 0 ? Math.round((imagePostCount / seenTotal) * 100) : 0;
    const images = imagePostCount > 0 ? ` · ${imagePostCount} had images (${imgPct}%)` : "";
    if (autoScan) {
      const full = pending.size >= PENDING_CAP ? " (backlog full — falling behind)" : "";
      const q = pending.size > 0 ? ` · ${pending.size} queued${full}` : "";
      const ads = adSkipCount > 0 ? ` · ${adSkipCount} ads skipped` : "";
      setStatus(`Watching as you scroll · ${scoredCount} scored${q}${ads}${images}`, "done");
    } else if (scoredCount > 0) {
      setStatus(`${scoredCount} scored this session${images}. Scan again for new posts.`, "done");
    }
  }

  function scoreClass(score) {
    if (score >= 7) return "rs-score-high";
    if (score >= 5) return "rs-score-mid";
    return "rs-score-low";
  }

  function renderResults(posts, results, append) {
    const byId = Object.fromEntries(posts.map((p) => [p.id, p]));
    const sorted = [...results].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    if (!append) resultsEl.innerHTML = "";

    const frag = document.createDocumentFragment();
    sorted.forEach((r) => {
      const p = byId[r.id];
      if (!p) return;

      const card = document.createElement("div");
      card.className = "rs-card" + (r.reply ? " rs-card-hit" : "");
      card.dataset.score = String(r.score ?? 0);
      card.innerHTML = `
        <div class="rs-card-top">
          <span class="rs-score ${scoreClass(r.score ?? 0)}">${(r.score ?? 0).toFixed ? (r.score ?? 0).toFixed(1) : r.score}</span>
          <span class="rs-author"></span>
        </div>
        <div class="rs-post-text"></div>
        <div class="rs-reason"></div>
      `;
      card.querySelector(".rs-author").textContent = `${p.author} ${p.handle}`.trim();
      card.querySelector(".rs-post-text").textContent = p.text.length > 180 ? p.text.slice(0, 180) + "…" : p.text;
      card.querySelector(".rs-reason").textContent = r.reason || "";

      if (r.reply) {
        incrementStat("draftedCount");
        const ta = document.createElement("textarea");
        ta.className = "rs-reply";
        ta.value = r.reply;
        ta.rows = 3;
        card.appendChild(ta);

        const row = document.createElement("div");
        row.className = "rs-actions";

        const copyBtn = document.createElement("button");
        copyBtn.className = "rs-btn";
        copyBtn.textContent = "Copy reply";
        copyBtn.addEventListener("click", () => {
          navigator.clipboard.writeText(ta.value).then(() => {
            copyBtn.textContent = "Copied";
            setTimeout(() => (copyBtn.textContent = "Copy reply"), 1500);
            incrementStat("copiedCount");
          });
        });
        row.appendChild(copyBtn);

        if (p.url) {
          const openBtn = document.createElement("button");
          openBtn.className = "rs-btn rs-btn-quiet";
          openBtn.textContent = "Open post";
          openBtn.addEventListener("click", () => window.open(p.url, "_blank"));
          row.appendChild(openBtn);
        }

        const jumpBtn = document.createElement("button");
        jumpBtn.className = "rs-btn rs-btn-quiet";
        jumpBtn.textContent = "Find on page";
        jumpBtn.addEventListener("click", () => {
          const el = document.querySelector(`article[data-reply-scout-id="${p.id}"]`);
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            el.classList.add("rs-flash");
            setTimeout(() => el.classList.remove("rs-flash"), 2000);
          }
        });
        row.appendChild(jumpBtn);

        card.appendChild(row);
      }

      frag.appendChild(card);
    });

    // Newest batch on top; drop overflow from the bottom, keeping reply-worthy cards longer
    resultsEl.prepend(frag);
    applyFilter();
    while (resultsEl.children.length > CARD_CAP) {
      let victim = null;
      for (let i = resultsEl.children.length - 1; i >= 0; i--) {
        if (!resultsEl.children[i].classList.contains("rs-card-hit")) { victim = resultsEl.children[i]; break; }
      }
      (victim || resultsEl.lastElementChild).remove();
    }
  }

  // ---------- timeline observation ----------
  const observer = new MutationObserver(() => {
    if (!autoScan || !onMonitoringPage) return;
    clearTimeout(observer._t);
    observer._t = setTimeout(collectNewPosts, 400); // let X finish rendering
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // X is a SPA — re-evaluate the page gate and re-collect when the URL
  // changes (switching between Home, Lists, profiles, status pages, etc.)
  let lastPath = location.pathname + location.search;
  setInterval(() => {
    const now = location.pathname + location.search;
    if (now !== lastPath) {
      lastPath = now;
      updatePageGate();
      if (autoScan && onMonitoringPage) setTimeout(collectNewPosts, 800);
    }
  }, 1000);
})();
