import assert from "node:assert/strict";
import test from "node:test";
import { handleWhoisRequest, parseWhoisTarget, whoisUpstreamUrl } from "../functions/_lib/whois.js";
import { safeEmail, safeHttpUrl, sitePayload } from "../functions/api/site.js";

test("single domain maps to who-dat /v1/whois and sends the bearer token", async () => {
  const calls = [];
  const response = await handleWhoisRequest(
    new Request("https://whoip.local/api/whois/Example.COM"),
    { WHOIS_API_BASE: "http://whois.internal:8080/", WHOIS_API_KEY: "secret" },
    async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ domain: "example.com", isRegistered: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://whois.internal:8080/v1/whois/example.com");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.headers.authorization, "Bearer secret");
  const body = await response.json();
  assert.equal(body.domain, "example.com");
});

test("IDN and bulk queries keep the who-dat paths", () => {
  const idn = parseWhoisTarget("https://whoip.local/api/whois/%E4%B8%AD%E5%9B%BD.cn");
  assert.equal(idn.ok, true);
  assert.equal(whoisUpstreamUrl("https://api.example", idn), "https://api.example/v1/whois/%E4%B8%AD%E5%9B%BD.cn");
  const multi = parseWhoisTarget("https://whoip.local/api/whois?domains=example.com,wikipedia.org");
  assert.equal(multi.kind, "multi");
  assert.equal(
    whoisUpstreamUrl("https://api.example", multi),
    "https://api.example/multi?domains=example.com%2Cwikipedia.org",
  );
});

test("missing base, bad domains, redirects and other methods never become an open proxy", async () => {
  let called = 0;
  const fetchImpl = async () => {
    called += 1;
    return new Response(null, { status: 302, headers: { location: "https://evil.example" } });
  };
  const missing = await handleWhoisRequest(new Request("https://whoip.local/api/whois/example.com"), {}, fetchImpl);
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).error.code, "NOT_CONFIGURED");

  const junk = await handleWhoisRequest(
    new Request("https://whoip.local/api/whois/example.com/extra"),
    { WHOIS_API_BASE: "http://whois.internal" },
    fetchImpl,
  );
  assert.equal(junk.status, 400);
  const escaped = await handleWhoisRequest(
    new Request("https://whoip.local/api/whois/example.com%2F..%2Fsecret"),
    { WHOIS_API_BASE: "http://whois.internal" },
    fetchImpl,
  );
  assert.equal(escaped.status, 400);
  const collapsed = await handleWhoisRequest(
    new Request("https://whoip.local/api/whois/example.com/../../etc"),
    { WHOIS_API_BASE: "http://whois.internal" },
    fetchImpl,
  );
  assert.equal(collapsed.status, 404);

  const posted = await handleWhoisRequest(
    new Request("https://whoip.local/api/whois/example.com", { method: "POST" }),
    { WHOIS_API_BASE: "http://whois.internal" },
    fetchImpl,
  );
  assert.equal(posted.status, 405);
  assert.equal(called, 0);

  const redirected = await handleWhoisRequest(
    new Request("https://whoip.local/api/whois/example.com"),
    { WHOIS_API_BASE: "http://whois.internal" },
    fetchImpl,
  );
  assert.equal(redirected.status, 502);
  assert.equal(called, 1);
  assert.match((await redirected.json()).error.message, /重定向/);
});

test("contact settings stay as mailto and http(s) links", () => {
  assert.equal(safeEmail("not an email"), "hello@example.com");
  assert.equal(safeEmail("you@example.com"), "you@example.com");
  assert.equal(safeHttpUrl("javascript:alert(1)"), "");
  assert.equal(safeHttpUrl("https://user:pass@example.com/x"), "");
  const payload = sitePayload({
    CONTACT_EMAIL: "you@example.com",
    CONTACT_URL: "https://example.com/about",
    CONTACT_URL_LABEL: "关于",
    WHOIS_API_BASE: "http://127.0.0.1:8080",
  });
  assert.equal(payload.contact.email, "you@example.com");
  assert.equal(payload.contact.url, "https://example.com/about");
  assert.equal(payload.whoisConfigured, true);
  assert.equal(JSON.stringify(payload).includes("127.0.0.1"), false);
});
