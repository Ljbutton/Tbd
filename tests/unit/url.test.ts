import { describe, expect, it } from "vitest";
import { hashUrl, isProbablyHtml, normalizeUrl, sameOrigin } from "../../src/scan/url.js";

describe("normalizeUrl", () => {
  it("drops the fragment and lowercases scheme and host", () => {
    expect(normalizeUrl("HTTPS://Example.COM/Path#section")).toBe("https://example.com/Path");
    expect(normalizeUrl("https://EXAMPLE.com/#")).toBe("https://example.com/");
  });

  it("drops default ports but keeps custom ones", () => {
    expect(normalizeUrl("http://example.com:80/a")).toBe("http://example.com/a");
    expect(normalizeUrl("https://example.com:443/a")).toBe("https://example.com/a");
    expect(normalizeUrl("http://example.com:8080/a")).toBe("http://example.com:8080/a");
    expect(normalizeUrl("https://example.com:80/a")).toBe("https://example.com:80/a");
  });

  it("removes tracking parameters and sorts the remaining ones", () => {
    expect(
      normalizeUrl("https://example.com/p?utm_source=nl&z=1&fbclid=abc&a=2&gclid=x&mc_cid=1&ref=twitter&refresh=1"),
    ).toBe("https://example.com/p?a=2&refresh=1&z=1");
    expect(normalizeUrl("https://example.com/p?utm_campaign=spring")).toBe("https://example.com/p");
    expect(normalizeUrl("https://example.com/p?b=2&a=1&a=0")).toBe("https://example.com/p?a=1&a=0&b=2");
  });

  it("collapses repeated slashes in the path", () => {
    expect(normalizeUrl("https://example.com//shop///candles//")).toBe("https://example.com/shop/candles/");
    expect(normalizeUrl("https://example.com")).toBe("https://example.com/");
  });

  it("keeps a trailing slash only on directory-like paths", () => {
    expect(normalizeUrl("https://example.com/shop/")).toBe("https://example.com/shop/");
    expect(normalizeUrl("https://example.com/shop")).toBe("https://example.com/shop");
    expect(normalizeUrl("https://example.com/about.html/")).toBe("https://example.com/about.html");
    expect(normalizeUrl("https://example.com/about.html")).toBe("https://example.com/about.html");
    expect(normalizeUrl("https://example.com/v1.2/docs/")).toBe("https://example.com/v1.2/docs/");
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("resolves relative references against a base", () => {
    const base = "https://www.example.com/shop/candles/index.html";
    expect(normalizeUrl("../about.html", base)).toBe("https://www.example.com/shop/about.html");
    expect(normalizeUrl("/contact.html?utm_medium=x#top", base)).toBe("https://www.example.com/contact.html");
    expect(normalizeUrl("soy.html", base)).toBe("https://www.example.com/shop/candles/soy.html");
    expect(normalizeUrl("//cdn.example.com/x", base)).toBe("https://cdn.example.com/x");
    expect(normalizeUrl("?b=1&a=2", base)).toBe("https://www.example.com/shop/candles/index.html?a=2&b=1");
  });

  it("is idempotent and throws on garbage", () => {
    const once = normalizeUrl("HTTP://Example.com:80//a/b.html/?utm_x=1&b=1&a=2#h");
    expect(once).toBe("http://example.com/a/b.html?a=2&b=1");
    expect(normalizeUrl(once)).toBe(once);
    expect(() => normalizeUrl("not a url")).toThrow();
    expect(() => normalizeUrl("/relative/without/base")).toThrow();
  });
});

describe("sameOrigin", () => {
  it("treats www and bare host as the same site", () => {
    expect(sameOrigin("https://www.example.com/a", "https://example.com/b")).toBe(true);
    expect(sameOrigin("https://example.com", "https://WWW.EXAMPLE.COM/x")).toBe(true);
    expect(sameOrigin(new URL("https://example.com/"), "https://www.example.com/")).toBe(true);
  });

  it("requires the same protocol, host and port", () => {
    expect(sameOrigin("http://example.com/", "https://example.com/")).toBe(false);
    expect(sameOrigin("https://example.com/", "https://shop.example.com/")).toBe(false);
    expect(sameOrigin("https://example.com/", "https://example.com:8443/")).toBe(false);
    expect(sameOrigin("https://example.com/", "https://example.org/")).toBe(false);
    expect(sameOrigin("http://127.0.0.1:4100/", "http://127.0.0.1:4100/about.html")).toBe(true);
    expect(sameOrigin("http://127.0.0.1:4100/", "http://127.0.0.1:4101/")).toBe(false);
  });

  it("returns false for unparsable input", () => {
    expect(sameOrigin("nope", "https://example.com/")).toBe(false);
    expect(sameOrigin("https://example.com/", "")).toBe(false);
  });
});

describe("isProbablyHtml", () => {
  it("rejects non-page schemes", () => {
    for (const link of ["mailto:hi@example.com", "tel:+15551234567", "javascript:void(0)", "JAVASCRIPT:alert(1)", "data:text/html,hi", "ftp://example.com/x"]) {
      expect(isProbablyHtml(link), link).toBe(false);
    }
  });

  it("rejects asset and binary extensions, case-insensitively and with a trailing slash", () => {
    for (const ext of ["pdf", "jpg", "jpeg", "png", "gif", "svg", "webp", "zip", "mp4", "mp3", "css", "js", "json", "xml", "ico", "woff", "woff2"]) {
      expect(isProbablyHtml(`https://example.com/file.${ext}`), ext).toBe(false);
      expect(isProbablyHtml(`/assets/file.${ext.toUpperCase()}`), ext).toBe(false);
      expect(isProbablyHtml(`https://example.com/file.${ext}/`), `${ext}/`).toBe(false);
      expect(isProbablyHtml(`https://example.com/file.${ext}?v=2`), `${ext}?v`).toBe(false);
    }
  });

  it("accepts pages, directories, extensionless paths and html files", () => {
    for (const link of ["https://example.com/", "https://example.com/about", "https://example.com/about/", "/products.html", "https://example.com/blog/post.php", "https://example.com/docs.pdf.html", "https://example.com/?page=2", "about.aspx", "https://example.com/jsx-guide"]) {
      expect(isProbablyHtml(link), link).toBe(true);
    }
  });

  it("rejects empty input", () => {
    expect(isProbablyHtml("")).toBe(false);
    expect(isProbablyHtml("   ")).toBe(false);
  });
});

describe("hashUrl", () => {
  it("is the sha256 hex digest of the string", () => {
    expect(hashUrl("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hashUrl("https://example.com/")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashUrl("https://example.com/")).not.toBe(hashUrl("https://example.com/a"));
  });
});
