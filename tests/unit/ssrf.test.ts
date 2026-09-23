import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpError } from "../../src/util/http.js";

// dns.lookup is mocked so these tests never touch the network. The mock is
// hoisted above every import, including the dynamic ones below.
const mocks = vi.hoisted(() => ({
  lookup: vi.fn<(host: string, options: { all: true }) => Promise<{ address: string; family: number }[]>>(),
}));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup, default: { lookup: mocks.lookup } }));

// The guard must be tested in its strict mode regardless of the developer's shell.
delete process.env.ALLOW_PRIVATE_TARGETS;
const { assertPublicUrl, isPublicIp, isBlockedHostname, resolveAddresses, SSRF_MESSAGES } = await import(
  "../../src/scan/ssrf.js"
);

function resolvesTo(...addresses: string[]): void {
  mocks.lookup.mockResolvedValue(addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected rejection with code ${code}`).not.toBeNull();
  const error = caught as HttpError;
  expect(error.code).toBe(code);
  expect(error.status).toBe(400);
  expect(error.message).toBe(SSRF_MESSAGES[code as keyof typeof SSRF_MESSAGES]);
}

beforeEach(() => {
  mocks.lookup.mockReset();
  resolvesTo("93.184.216.34");
});

describe("isPublicIp", () => {
  it("accepts public IPv4 addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "104.16.0.1", "172.15.255.255", "172.32.0.1", "192.169.0.1", "100.63.255.255", "100.128.0.0", "198.17.255.255", "198.20.0.1", "223.255.255.255"]) {
      expect(isPublicIp(ip), ip).toBe(true);
    }
  });

  it("rejects every blocked IPv4 range", () => {
    for (const ip of [
      "0.0.0.0",
      "0.255.255.255",
      "10.0.0.1",
      "10.255.255.255",
      "100.64.0.1",
      "100.127.255.255",
      "127.0.0.1",
      "127.255.255.254",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.19.255.255",
      "224.0.0.1",
      "239.255.255.255",
      "240.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
  });

  it("accepts public IPv6 addresses", () => {
    for (const ip of ["2001:4860:4860::8888", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8", "::ffff:808:808", "[2001:db8::1]"]) {
      expect(isPublicIp(ip), ip).toBe(true);
    }
  });

  it("rejects blocked IPv6 addresses", () => {
    for (const ip of [
      "::",
      "::1",
      "fc00::1",
      "fd12:3456:789a::1",
      "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "fe80::1",
      "fe80::1%eth0",
      "febf::1",
      "ff02::1",
      "ff00::",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "::ffff:7f00:1",
      "::ffff:169.254.169.254",
      "64:ff9b::8.8.8.8",
      "64:ff9b::808:808",
      "[::1]",
    ]) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
  });

  it("treats anything that is not an IP literal as not public", () => {
    for (const value of ["", " ", "example.com", "999.1.1.1", "1.2.3", "::g", "12345::", "8.8.8.8/24"]) {
      expect(isPublicIp(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe("isBlockedHostname", () => {
  it("blocks internal naming conventions and private IP literals", () => {
    for (const host of ["localhost", "LOCALHOST", "localhost.", "app.localhost", "printer.local", "db.internal", "nas.home.arpa", "127.0.0.1", "[::1]", "10.1.2.3", "169.254.169.254", ""]) {
      expect(isBlockedHostname(host), host).toBe(true);
    }
  });

  it("allows ordinary public hostnames and IPs without consulting DNS", () => {
    for (const host of ["example.com", "www.example.co.uk", "my-internal-tools.com", "localhost.example.com", "8.8.8.8", "[2001:db8::1]"]) {
      expect(isBlockedHostname(host), host).toBe(false);
    }
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
});

describe("assertPublicUrl", () => {
  it("prepends https:// when no scheme is given and keeps the rest of the address", async () => {
    const url = await assertPublicUrl("example.com");
    expect(url.href).toBe("https://example.com/");
    const withPath = await assertPublicUrl("  Example.com/Shop?a=1  ");
    expect(withPath.href).toBe("https://example.com/Shop?a=1");
    const withPort = await assertPublicUrl("example.com:8080");
    expect(withPort.href).toBe("https://example.com:8080/");
    const explicit = await assertPublicUrl("http://example.com/page.html#top");
    expect(explicit.protocol).toBe("http:");
    expect(explicit.pathname).toBe("/page.html");
    expect(mocks.lookup).toHaveBeenCalledWith("example.com", { all: true });
  });

  it("rejects malformed input with invalid_url", async () => {
    await expectCode(assertPublicUrl(""), "invalid_url");
    await expectCode(assertPublicUrl("   "), "invalid_url");
    await expectCode(assertPublicUrl("not a url"), "invalid_url");
    await expectCode(assertPublicUrl("https://"), "invalid_url");
    await expectCode(assertPublicUrl("https://exa mple.com"), "invalid_url");
    await expectCode(assertPublicUrl("https://example.com:99999"), "invalid_url");
    await expectCode(assertPublicUrl(`https://example.com/${"a".repeat(2048)}`), "invalid_url");
  });

  it("rejects non-http schemes and userinfo with invalid_url", async () => {
    await expectCode(assertPublicUrl("ftp://example.com/file"), "invalid_url");
    await expectCode(assertPublicUrl("file:///etc/passwd"), "invalid_url");
    await expectCode(assertPublicUrl("javascript://example.com/%0aalert(1)"), "invalid_url");
    await expectCode(assertPublicUrl("gopher://example.com"), "invalid_url");
    await expectCode(assertPublicUrl("https://user:pw@example.com/"), "invalid_url");
    await expectCode(assertPublicUrl("https://user@example.com/"), "invalid_url");
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it("rejects internal hostnames and private IP literals with blocked_target before any DNS lookup", async () => {
    for (const input of [
      "localhost",
      "http://localhost:3000/",
      "https://api.localhost/",
      "https://printer.local/",
      "https://db.internal/",
      "https://nas.home.arpa/",
      "http://127.0.0.1/",
      "http://127.1/",
      "http://0x7f000001/",
      "http://2130706433/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://10.0.0.5/",
      "http://169.254.169.254/latest/meta-data/",
      "http://192.168.0.1/",
      "http://172.16.0.1/",
      "http://0.0.0.0/",
      "http://[fe80::1]/",
      "http://[fd00::1]/",
    ]) {
      await expectCode(assertPublicUrl(input), "blocked_target");
    }
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it("rejects hostnames that resolve to a private address (including mixed answers)", async () => {
    resolvesTo("10.1.2.3");
    await expectCode(assertPublicUrl("https://intranet.example.com/"), "blocked_target");
    resolvesTo("93.184.216.34", "127.0.0.1");
    await expectCode(assertPublicUrl("https://rebinding.example.com/"), "blocked_target");
    resolvesTo("2606:4700::1111", "fd00::1");
    await expectCode(assertPublicUrl("https://v6.example.com/"), "blocked_target");
  });

  it("accepts hostnames whose every address is public", async () => {
    resolvesTo("93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946");
    const url = await assertPublicUrl("https://dual.example.com/");
    expect(url.hostname).toBe("dual.example.com");
  });

  it("reports DNS failures and empty answers as dns_failed", async () => {
    mocks.lookup.mockRejectedValue(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));
    await expectCode(assertPublicUrl("https://does-not-exist.invalid/"), "dns_failed");
    mocks.lookup.mockResolvedValue([]);
    await expectCode(assertPublicUrl("https://empty.example.com/"), "dns_failed");
  });
});

describe("resolveAddresses", () => {
  it("returns IP literals without a lookup and every DNS answer otherwise", async () => {
    expect(await resolveAddresses("8.8.8.8")).toEqual(["8.8.8.8"]);
    expect(await resolveAddresses("[2001:db8::1]")).toEqual(["2001:db8::1"]);
    expect(mocks.lookup).not.toHaveBeenCalled();
    resolvesTo("1.1.1.1", "1.0.0.1");
    expect(await resolveAddresses("one.one.one.one")).toEqual(["1.1.1.1", "1.0.0.1"]);
  });
});

describe("ALLOW_PRIVATE_TARGETS=1", () => {
  it("skips the private-network checks but still enforces scheme, userinfo and length", async () => {
    vi.resetModules();
    process.env.ALLOW_PRIVATE_TARGETS = "1";
    try {
      const relaxed = await import("../../src/scan/ssrf.js");
      const local = await relaxed.assertPublicUrl("http://127.0.0.1:4100/");
      expect(local.href).toBe("http://127.0.0.1:4100/");
      const host = await relaxed.assertPublicUrl("localhost:3000");
      expect(host.href).toBe("https://localhost:3000/");
      expect(mocks.lookup).not.toHaveBeenCalled();
      await expectCode(relaxed.assertPublicUrl("ftp://127.0.0.1/"), "invalid_url");
      await expectCode(relaxed.assertPublicUrl("http://root:secret@127.0.0.1/"), "invalid_url");
      // The raw IP verdict is unaffected by the flag (the route guard relies on this).
      expect(relaxed.isPublicIp("127.0.0.1")).toBe(false);
      expect(await relaxed.isAllowedHost("127.0.0.1")).toBe(true);
    } finally {
      delete process.env.ALLOW_PRIVATE_TARGETS;
      vi.resetModules();
    }
  });
});
