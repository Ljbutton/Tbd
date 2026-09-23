// One shared headless Chromium for the whole process. Contexts are created per
// scan (desktop or mobile) with a route guard that keeps the browser from
// reaching private networks and from downloading media/fonts.

import { chromium, devices, type Browser, type BrowserContext, type Route } from "playwright";
import type { Viewport } from "../types.js";
import { isAllowedHost, stripBrackets } from "./ssrf.js";

export const BOT_UA_SUFFIX = "AccessAuditBot/1.0 (+https://accessaudit.example/bot)";
export const CHROMIUM_ARGS = ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"];
export const CONTEXT_DEFAULT_TIMEOUT_MS = 30000;
export const DESKTOP_VIEWPORT = { width: 1280, height: 800 } as const;
export const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;

/** Resource types that never affect accessibility results and only cost bandwidth. */
const ABORTED_RESOURCE_TYPES = new Set(["media", "font"]);

let browserPromise: Promise<Browser> | null = null;
let browserInstance: Browser | null = null;

/** True once a shared Chromium instance is running (reported by /healthz). */
export let browserReady = false;

export function isBrowserReady(): boolean {
  return browserReady && browserInstance !== null && browserInstance.isConnected();
}

function forget(browser: Browser): void {
  if (browserInstance === browser) {
    browserInstance = null;
    browserPromise = null;
    browserReady = false;
  }
}

/** Launches Chromium on first use and reuses it until closeBrowser() (or a crash). */
export async function getBrowser(): Promise<Browser> {
  if (browserInstance !== null && browserInstance.isConnected()) return browserInstance;
  if (browserPromise !== null) return browserPromise;

  browserPromise = chromium
    .launch({ headless: true, args: CHROMIUM_ARGS })
    .then((browser) => {
      browserInstance = browser;
      browserReady = true;
      browser.on("disconnected", () => forget(browser));
      return browser;
    })
    .catch((err: unknown) => {
      browserPromise = null;
      browserReady = false;
      throw err;
    });
  return browserPromise;
}

/** Closes the shared browser (called at the end of every audit to free memory). Safe to call when nothing is open. */
export async function closeBrowser(): Promise<void> {
  const pending = browserPromise;
  browserPromise = null;
  let browser = browserInstance;
  browserInstance = null;
  browserReady = false;
  if (browser === null && pending !== null) {
    try {
      browser = await pending;
    } catch {
      browser = null;
    }
  }
  if (browser === null) return;
  try {
    await browser.close();
  } catch {
    // Already gone; nothing to free.
  }
}

/** Chrome major version of the running browser, for a realistic desktop user agent. */
function chromeVersionTag(browser: Browser): string {
  const major = browser.version().split(".")[0];
  return /^\d+$/.test(major ?? "") ? `${major}.0.0.0` : "131.0.0.0";
}

function desktopUserAgent(browser: Browser): string {
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersionTag(browser)} Safari/537.36 ${BOT_UA_SUFFIX}`;
}

function mobileUserAgent(): string {
  const base = devices["iPhone 13"]?.userAgent ?? "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1";
  return `${base} ${BOT_UA_SUFFIX}`;
}

/**
 * Route guard installed on every scan context: aborts requests to hosts that
 * are not public (DNS resolved once per host per context) and drops media and
 * font downloads. Everything else, including images and CSS, continues so
 * contrast checks and screenshots stay accurate.
 */
export function installRouteGuard(context: BrowserContext): void {
  const hostCache = new Map<string, Promise<boolean>>();

  const hostAllowed = (hostname: string): Promise<boolean> => {
    const key = stripBrackets(hostname.toLowerCase());
    let cached = hostCache.get(key);
    if (cached === undefined) {
      cached = isAllowedHost(key).catch(() => false);
      hostCache.set(key, cached);
    }
    return cached;
  };

  const handler = async (route: Route): Promise<void> => {
    const request = route.request();
    try {
      if (ABORTED_RESOURCE_TYPES.has(request.resourceType())) {
        await route.abort("blockedbyclient");
        return;
      }
      let url: URL;
      try {
        url = new URL(request.url());
      } catch {
        await route.abort("blockedbyclient");
        return;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        await route.continue();
        return;
      }
      if (!(await hostAllowed(url.hostname))) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    } catch {
      // The page or context closed while we were deciding; nothing to do.
    }
  };

  void context.route("**/*", (route) => {
    void handler(route);
  });
}

/**
 * New isolated context for one scan. Desktop is 1280x800 with a Chrome UA;
 * mobile emulates an iPhone 13 at 390x844. Both carry the AccessAuditBot UA
 * suffix, a 30s default timeout and the route guard.
 */
export async function newScanContext(viewport: Viewport): Promise<BrowserContext> {
  const browser = await getBrowser();
  const context =
    viewport === "mobile"
      ? await browser.newContext({
          ...devices["iPhone 13"],
          viewport: { ...MOBILE_VIEWPORT },
          userAgent: mobileUserAgent(),
        })
      : await browser.newContext({
          viewport: { ...DESKTOP_VIEWPORT },
          userAgent: desktopUserAgent(browser),
        });
  context.setDefaultTimeout(CONTEXT_DEFAULT_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(CONTEXT_DEFAULT_TIMEOUT_MS);
  installRouteGuard(context);
  return context;
}

/** Closes a context, swallowing errors from contexts that are already gone. */
export async function closeContext(context: BrowserContext | null | undefined): Promise<void> {
  if (!context) return;
  try {
    await context.close();
  } catch {
    // Already closed.
  }
}
