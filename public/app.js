/*
 * AccessAudit progressive enhancement. Every page works without this file;
 * with it:
 *   - the free-scan form posts JSON to /api/teaser and renders the result card
 *     in place (with the friendly 400 / 429 / 504 messages);
 *   - [data-copy-target="#id"] and [data-copy-url="/path"] buttons copy to the
 *     clipboard and confirm in a live region;
 *   - [data-poll-url] elements poll a JSON status endpoint every
 *     data-poll-interval ms (default 3000), fill [data-poll-field="name"]
 *     children and reload the page when the status says ready or failed.
 * No dependencies, no modules, no cookies.
 */
(function () {
  "use strict";

  var IMPACT_LABELS = { critical: "Critical", serious: "Serious", moderate: "Moderate", minor: "Minor" };
  var MESSAGES = {
    invalid: "Enter a full website address like https://example.com",
    rateLimited: "5 free scans per hour. Buy a full audit for the whole site.",
    timeout: "That page took too long to load. Try again or scan a different page.",
    generic: "We couldn't scan that page right now. Try again in a minute.",
  };
  var FETCH_TIMEOUT_MS = 90000;

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined || value === false) return;
        if (key === "text") {
          node.textContent = String(value);
        } else if (key === "className") {
          node.className = String(value);
        } else {
          node.setAttribute(key, String(value));
        }
      });
    }
    if (children) {
      children.forEach(function (child) {
        if (child === null || child === undefined || child === false) return;
        node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
      });
    }
    return node;
  }

  function plural(n, word) {
    return n + " " + word + (n === 1 ? "" : "s");
  }

  function normalizeAddress(value) {
    var text = (value || "").trim();
    if (!text) return "";
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = "https://" + text;
    return text;
  }

  function messageFor(status, body) {
    var msg = body && typeof body.message === "string" ? body.message : "";
    if (status === 429) return msg || MESSAGES.rateLimited;
    if (status === 400) return msg || MESSAGES.invalid;
    if (status === 504) return msg || MESSAGES.timeout;
    return msg || MESSAGES.generic;
  }

  /* ---------------------------------------------------------------- teaser */

  function buildIssueCard(issue) {
    var head = el("div", { className: "issue-card__head" }, [
      el("h3", { text: issue.title || issue.ruleId || "Issue" }),
      el("span", { className: "badge badge-" + (issue.impact || "moderate"), text: IMPACT_LABELS[issue.impact] || issue.impact || "Issue" }),
      el("span", { className: "small muted", text: plural(Number(issue.nodes) || 0, "element") + " on this page" }),
    ]);
    var children = [head, el("p", { text: issue.plainEnglish || "" })];
    if (issue.screenshotDataUrl && /^data:image\/png;base64,/.test(issue.screenshotDataUrl)) {
      children.push(
        el("img", {
          className: "issue-shot",
          src: issue.screenshotDataUrl,
          alt: "Screenshot of the element on the scanned page that fails the check: " + (issue.title || issue.ruleId || "issue"),
        }),
      );
    }
    if (issue.exampleHtml) {
      children.push(el("pre", { className: "issue-code" }, [el("code", { text: issue.exampleHtml })]));
    }
    return el("li", { className: "issue-card" }, children);
  }

  function buildResultCard(data, orderBase, pageLimit) {
    var top = Array.isArray(data.top) ? data.top : [];
    var heading = el("h2", {
      className: "teaser-card__title",
      tabindex: "-1",
      text: (Number(data.violationNodes) || 0) + " issues on this page across " + (Number(data.rulesFailed) || 0) + " rules",
    });
    var children = [heading];
    if (data.cached) children.push(el("p", { className: "small muted", text: "Cached result from the last 24 hours." }));
    if (top.length === 0) {
      children.push(
        el("p", {
          text: "Nothing on this page failed our automated checks. That is a good sign, but automated checks find roughly 30-40% of WCAG issues, and the rest of your site may differ.",
        }),
      );
    } else {
      children.push(el("p", { className: "muted", text: "The " + top.length + " highest-ranked problems, with the exact markup that failed:" }));
      children.push(el("ol", { className: "issue-list" }, top.map(buildIssueCard)));
    }
    var manual = Number(data.needsManualCount) || 0;
    if (manual > 0) {
      children.push(el("p", { className: "small muted mt-2", text: plural(manual, "more item") + " on this page need a person to check; the full audit lists them." }));
    }
    var orderUrl = orderBase + (orderBase.indexOf("?") >= 0 ? "&" : "?") + "url=" + encodeURIComponent(data.url || "");
    children.push(
      el("footer", { className: "teaser-card__footer" }, [
        el("p", { text: "This is one page at desktop size. The full audit scans up to " + pageLimit + " pages at desktop and mobile." }),
        el("a", { className: "btn btn-primary btn-lg", href: orderUrl, text: "Get the full-site audit — $49" }),
      ]),
    );
    return el("div", { className: "card teaser-card" }, children);
  }

  function initTeaser() {
    var form = document.querySelector("[data-teaser-form]");
    if (!form || typeof window.fetch !== "function") return;
    var input = form.querySelector('input[name="url"]');
    var button = form.querySelector("[data-teaser-submit]");
    var status = form.querySelector("[data-teaser-status]");
    var resultBox = document.querySelector("[data-teaser-result]");
    if (!input || !button || !resultBox) return;
    var orderBase = form.getAttribute("data-order-url") || "/order?product=single";
    var pageLimit = Number(form.getAttribute("data-page-limit")) || 15;
    var buttonLabel = button.textContent;
    var busy = false;

    function setStatus(text, isError) {
      if (!status) return;
      status.textContent = text || "";
      status.classList.toggle("is-error", !!isError);
    }

    function setBusy(state) {
      busy = state;
      button.disabled = state;
      button.setAttribute("aria-busy", state ? "true" : "false");
      button.textContent = state ? "Scanning…" : buttonLabel;
    }

    function showError(message) {
      resultBox.hidden = true;
      resultBox.textContent = "";
      setStatus(message, true);
      input.setAttribute("aria-invalid", "true");
      input.focus();
    }

    function showResult(data) {
      input.removeAttribute("aria-invalid");
      setStatus("Scan complete.", false);
      resultBox.textContent = "";
      resultBox.appendChild(buildResultCard(data, orderBase, pageLimit));
      resultBox.hidden = false;
      var heading = resultBox.querySelector("h2");
      if (heading) heading.focus();
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (busy) return;
      var url = normalizeAddress(input.value);
      if (!url) {
        showError(MESSAGES.invalid);
        return;
      }
      input.value = url;
      input.removeAttribute("aria-invalid");
      setBusy(true);
      setStatus("Loading the page and running the accessibility checks. This takes 10-40 seconds.", false);

      var controller = typeof AbortController === "function" ? new AbortController() : null;
      var timer = controller ? setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS) : null;

      fetch("/api/teaser", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ url: url }),
        signal: controller ? controller.signal : undefined,
      })
        .then(function (response) {
          return response
            .json()
            .catch(function () { return null; })
            .then(function (body) { return { status: response.status, body: body }; });
        })
        .then(function (reply) {
          if (reply.status === 200 && reply.body && typeof reply.body === "object") {
            showResult(reply.body);
          } else {
            showError(messageFor(reply.status, reply.body));
          }
        })
        .catch(function (err) {
          showError(err && err.name === "AbortError" ? MESSAGES.timeout : MESSAGES.generic);
        })
        .then(function () {
          if (timer) clearTimeout(timer);
          setBusy(false);
        });
    });

    // embed.js sends visitors to /?url=...#scan: put the cursor in the box so Enter
    // runs the scan. The browser's own scroll-to-fragment runs the focusing steps on
    // the #scan box (not focusable, so it blurs whatever had focus), and it can happen
    // as late as the load event, so the focus is applied after load, not on DOM ready.
    function focusScanBox() {
      if (window.location.hash !== "#scan") return;
      try {
        input.focus({ preventScroll: true });
        input.setSelectionRange(input.value.length, input.value.length);
      } catch (err) {
        /* selection APIs are optional */
      }
    }
    if (input.value) {
      if (document.readyState === "complete") {
        setTimeout(focusScanBox, 0);
      } else {
        window.addEventListener("load", function () { setTimeout(focusScanBox, 0); });
      }
    }
    // Nav "Free scan" links point at #scan: land the cursor in the box as well.
    window.addEventListener("hashchange", function () { setTimeout(focusScanBox, 0); });
  }

  /* ------------------------------------------------------------- clipboard */

  function copyText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (err) {
        ok = false;
      }
      document.body.removeChild(area);
      ok ? resolve() : reject(new Error("copy failed"));
    });
  }

  // The live region sits next to the button (never inside it) so the button's
  // accessible name stays "Copy snippet" / "Copied" and resetting the label
  // does not remove the region.
  function announce(button, text) {
    var live = button.nextElementSibling;
    if (!live || !live.hasAttribute("data-copy-live")) {
      live = el("span", { className: "visually-hidden", role: "status", "aria-live": "polite", "data-copy-live": "" });
      button.parentNode.insertBefore(live, button.nextSibling);
    }
    live.textContent = text;
  }

  function initCopyButtons() {
    var buttons = document.querySelectorAll("[data-copy-target], [data-copy-url]");
    Array.prototype.forEach.call(buttons, function (button) {
      var label = button.textContent;
      button.addEventListener("click", function () {
        var target = button.getAttribute("data-copy-target");
        var url = button.getAttribute("data-copy-url");
        var source;
        if (target) {
          var node = document.querySelector(target);
          source = Promise.resolve(node ? node.textContent : "");
        } else if (url && typeof window.fetch === "function") {
          source = fetch(url, { headers: { Accept: "text/html" } }).then(function (response) {
            if (!response.ok) throw new Error("fetch failed");
            return response.text();
          });
        } else {
          source = Promise.reject(new Error("nothing to copy"));
        }
        source
          .then(function (text) { return copyText(text || ""); })
          .then(function () {
            button.textContent = "Copied";
            announce(button, "Copied to clipboard");
            setTimeout(function () {
              button.textContent = label;
            }, 2000);
          })
          .catch(function () {
            announce(button, "Copy failed. Select the text and copy it by hand.");
          });
      });
    });
  }

  /* --------------------------------------------------------------- polling */

  function initPolling() {
    var nodes = document.querySelectorAll("[data-poll-url]");
    Array.prototype.forEach.call(nodes, function (node) {
      var url = node.getAttribute("data-poll-url");
      if (!url || typeof window.fetch !== "function") return;
      var interval = Math.max(1000, Number(node.getAttribute("data-poll-interval")) || 3000);
      var stopped = false;

      function apply(data) {
        var fields = node.querySelectorAll("[data-poll-field]");
        Array.prototype.forEach.call(fields, function (field) {
          var key = field.getAttribute("data-poll-field");
          if (key && Object.prototype.hasOwnProperty.call(data, key) && data[key] !== null && data[key] !== undefined) {
            field.textContent = String(data[key]);
          }
        });
        var bar = node.querySelector("[data-poll-bar]");
        if (bar && Number(data.pageLimit) > 0) {
          var pct = Math.min(100, Math.round((100 * (Number(data.progressPages) || 0)) / Number(data.pageLimit)));
          bar.style.width = pct + "%";
        }
      }

      function tick() {
        if (stopped) return;
        fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" })
          .then(function (response) { return response.ok ? response.json() : null; })
          .then(function (data) {
            if (!data) return;
            apply(data);
            var status = typeof data.status === "string" ? data.status : "";
            if (data.ready === true || status === "ready" || status === "failed" || status === "held" || data.error) {
              stopped = true;
              window.location.reload();
            }
          })
          .catch(function () { /* transient; try again on the next tick */ })
          .then(function () {
            if (!stopped) setTimeout(tick, interval);
          });
      }
      setTimeout(tick, interval);
    });
  }

  /* ------------------------------------------------------------------ boot */

  function boot() {
    initTeaser();
    initCopyButtons();
    initPolling();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
