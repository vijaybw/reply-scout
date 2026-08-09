// Reply Scout — dark mode toggle, shared by options.html and content.js's
// panel via the same chrome.storage.local "theme" key. Kept in its own
// external file because MV3's default extension-page CSP blocks inline
// <script> tags outright.
(function () {
  var root = document.documentElement;
  var btn = document.getElementById("themeToggle");
  if (!btn) return;

  function apply(theme) {
    if (theme === "dark" || theme === "light") root.setAttribute("data-theme", theme);
  }
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get({ theme: "" }, function (s) { apply(s.theme); });
  }

  function current() {
    var attr = root.getAttribute("data-theme");
    if (attr) return attr;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  btn.addEventListener("click", function () {
    var next = current() === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ theme: next });
    }
  });
})();
