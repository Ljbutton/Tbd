/*
 * AccessAudit embed: drops a "Scan my site free" form into the page.
 *
 *   <div id="accessaudit-embed"></div>
 *   <script src="https://YOUR-ACCESSAUDIT-HOST/embed.js" async></script>
 *
 * Optional: data-base="https://YOUR-ACCESSAUDIT-HOST" on the script tag when
 * the script is served from somewhere else. Submitting navigates the top-level
 * window to {base}/?url=...#scan. No cookies, no tracking, no dependencies.
 */
(function () {
  "use strict";

  function findScript() {
    if (document.currentScript) return document.currentScript;
    var scripts = document.getElementsByTagName("script");
    for (var i = scripts.length - 1; i >= 0; i--) {
      if (/\/embed\.js(\?|#|$)/.test(scripts[i].getAttribute("src") || "")) return scripts[i];
    }
    return null;
  }

  function originOf(src) {
    var a = document.createElement("a");
    a.href = src;
    return a.protocol && a.host ? a.protocol + "//" + a.host : "";
  }

  var script = findScript();
  var base = (script && script.getAttribute("data-base")) || (script && script.src ? originOf(script.src) : "") || "";
  base = base.replace(/\/+$/, "");
  if (!base) return;

  var host = document.getElementById("accessaudit-embed");
  if (!host) {
    host = document.createElement("div");
    host.id = "accessaudit-embed";
    if (script && script.parentNode) {
      script.parentNode.insertBefore(host, script.nextSibling);
    } else {
      document.body.appendChild(host);
    }
  }
  if (host.getAttribute("data-accessaudit-ready") === "1") return;
  host.setAttribute("data-accessaudit-ready", "1");

  var uid = "aa-embed-" + Math.random().toString(36).slice(2, 8);

  var form = document.createElement("form");
  form.setAttribute("action", base + "/");
  form.setAttribute("method", "get");
  // Bare domains ("yourstore.com") are welcome: the handler adds https:// itself,
  // so the browser's own type="url" validation must not block the submit.
  form.noValidate = true;
  form.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;align-items:center;font:16px/1.4 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;margin:0";

  var label = document.createElement("label");
  label.setAttribute("for", uid);
  label.textContent = "Your website address";
  label.style.cssText = "position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0";

  var input = document.createElement("input");
  input.type = "url";
  input.name = "url";
  input.id = uid;
  input.placeholder = "https://yourstore.com";
  input.required = true;
  input.setAttribute("autocomplete", "url");
  input.setAttribute("inputmode", "url");
  input.style.cssText = "flex:1 1 220px;min-height:44px;padding:8px 12px;border:1px solid #6b7280;border-radius:6px;font:inherit;color:#1f2937;background:#fff;box-sizing:border-box";

  var button = document.createElement("button");
  button.type = "submit";
  button.textContent = "Scan my site free";
  button.style.cssText = "min-height:44px;padding:8px 18px;border:2px solid #1d4ed8;border-radius:6px;background:#1d4ed8;color:#fff;font:inherit;font-weight:600;cursor:pointer";

  var powered = document.createElement("a");
  powered.href = base + "/";
  powered.textContent = "Powered by AccessAudit";
  powered.setAttribute("rel", "noopener");
  powered.style.cssText = "flex:1 0 100%;font-size:13px;color:#4b5563;text-decoration:underline";

  form.appendChild(label);
  form.appendChild(input);
  form.appendChild(button);
  form.appendChild(powered);
  host.appendChild(form);

  function normalize(value) {
    var text = (value || "").trim();
    if (text && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = "https://" + text;
    return text;
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var url = normalize(input.value);
    if (!url) {
      input.focus();
      return;
    }
    var target = base + "/?url=" + encodeURIComponent(url) + "#scan";
    try {
      window.top.location.href = target;
    } catch (err) {
      window.location.href = target;
    }
  });
})();
