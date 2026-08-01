// Reply Scout — content script (v1.2)
// Auto-scan mode: watches the timeline as you scroll, batches new posts
// intelligently, skips ads, and never re-scores the same post twice.
// Still copy-only: this extension never posts, likes, or follows for you.

(() => {
  if (window.__replyScoutLoaded) return;
  window.__replyScoutLoaded = true;

  // ---------- state ----------
  const seen = new Set();        // keys of posts already sent for scoring
  const pending = new Map();     // key -> post object waiting to be scored
  let inFlight = false;
  let autoScan = false;
  let debounceTimer = null;
  let scoredCount = 0;
  let adSkipCount = 0;
  let hideBelow = true;          // hide cards under the draft threshold
  let minScore = 6;              // mirrors "Draft replies at score >=" in settings

  const BATCH_MAX = 10;          // posts per request (kind to local models)
  const BATCH_TRIGGER = 5;       // flush immediately once this many are queued
  const DEBOUNCE_MS = 2500;      // otherwise flush this long after scrolling settles
  const CARD_CAP = 60;           // max result cards kept in the panel

  chrome.storage.local.get({ autoScan: false, hideBelow: true, minScore: 6 }).then((s) => {
    autoScan = s.autoScan;
    hideBelow = s.hideBelow;
    minScore = parseFloat(s.minScore) || 6;
    updateAutoUI();
    updateFilterUI();
    if (autoScan) collectNewPosts();
  });

  // Keep the threshold in sync if the user changes it in settings mid-session
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.minScore) {
      minScore = parseFloat(changes.minScore.newValue) || 6;
      updateFilterUI();
      applyFilter();
    }
  });

  // ---------- ad / promoted detection ----------
  function isAd(article) {
    if (article.querySelector('[data-testid="placementTracking"]')) return true;
    // Promoted posts carry a small "Ad" or "Promoted" label span
    const spans = article.querySelectorAll("span");
    for (const s of spans) {
      const t = s.textContent.trim();
      if (t === "Ad" || t === "Promoted") return true;
    }
    return false;
  }

  // ---------- post extraction ----------
  function postKey(p) {
    return p.url || p.handle + "::" + p.text.slice(0, 80);
  }

  function extractArticle(article) {
    const textEl = article.querySelector('[data-testid="tweetText"]');
    const text = textEl ? textEl.innerText.trim() : "";
    if (!text) return null;

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

    return { author, handle, text: text.slice(0, 1000), url, engagement, _article: article };
  }

  function collectNewPosts() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    let added = 0;
    articles.forEach((article) => {
      if (article.dataset.replyScoutSeen) return;
      const p = extractArticle(article);
      if (!p) { article.dataset.replyScoutSeen = "1"; return; }
      const key = postKey(p);
      if (seen.has(key) || pending.has(key)) { article.dataset.replyScoutSeen = "1"; return; }
      if (isAd(article)) {
        article.dataset.replyScoutSeen = "1";
        adSkipCount++;
        return;
      }
      p.id = "rs-" + Math.random().toString(36).slice(2, 10);
      article.dataset.replyScoutId = p.id;
      article.dataset.replyScoutSeen = "1";
      pending.set(key, p);
      added++;
    });
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

  function flush() {
    clearTimeout(debounceTimer);
    if (inFlight || pending.size === 0) return;
    const batch = takeBatch();
    inFlight = true;
    setStatus(`Scoring ${batch.length} post${batch.length === 1 ? "" : "s"}… (${pending.size} queued)`, "busy");

    const payload = batch.map(({ _article, ...rest }) => rest);
    chrome.runtime.sendMessage({ type: "SCORE_POSTS", posts: payload }, (resp) => {
      inFlight = false;
      if (chrome.runtime.lastError) {
        setStatus("Extension error: " + chrome.runtime.lastError.message, "warn");
        return;
      }
      if (!resp || !resp.ok) {
        setStatus(resp ? resp.error : "No response from background worker.", "warn");
        // Put the batch back so it isn't silently lost on a transient failure
        batch.forEach((p) => { const k = postKey(p); seen.delete(k); pending.set(k, p); });
        return;
      }
      scoredCount += batch.length;
      renderResults(batch, resp.results, /*append*/ true);
      // More queued? keep going after a breather (local model is serial)
      if (autoScan && pending.size > 0) setTimeout(flush, 500);
      else updateStatusIdle();
    });
  }

  // ---------- panel UI ----------
  const panel = document.createElement("div");
  panel.id = "reply-scout-panel";
  panel.innerHTML = `
    <div class="rs-header">
      <span class="rs-title">Reply Scout</span>
      <span class="rs-header-actions">
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
      <div id="rs-status" class="rs-status">Nothing is ever posted for you. Ads are skipped automatically.</div>
      <div id="rs-results" class="rs-results"></div>
    </div>
  `;
  document.documentElement.appendChild(panel);

  const scanBtn = panel.querySelector("#rs-scan");
  const statusEl = panel.querySelector("#rs-status");
  const resultsEl = panel.querySelector("#rs-results");
  const autoToggle = panel.querySelector("#rs-auto");

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

  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = "rs-status" + (kind ? " rs-" + kind : "");
  }

  function updateStatusIdle() {
    if (inFlight) return;
    if (autoScan) {
      const q = pending.size > 0 ? ` · ${pending.size} queued` : "";
      const ads = adSkipCount > 0 ? ` · ${adSkipCount} ads skipped` : "";
      setStatus(`Watching as you scroll · ${scoredCount} scored${q}${ads}`, "done");
    } else if (scoredCount > 0) {
      setStatus(`${scoredCount} scored this session. Scan again for new posts.`, "done");
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
    if (!autoScan) return;
    clearTimeout(observer._t);
    observer._t = setTimeout(collectNewPosts, 400); // let X finish rendering
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // X is a SPA — re-collect when the URL changes (switching lists/searches)
  let lastPath = location.pathname + location.search;
  setInterval(() => {
    const now = location.pathname + location.search;
    if (now !== lastPath) {
      lastPath = now;
      if (autoScan) setTimeout(collectNewPosts, 800);
    }
  }, 1000);
})();
