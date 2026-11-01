import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pages = ["public/index.html", "public/whois/index.html", "public/contact/index.html"];

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("every page shares the WhoIP navigation and a single contact URL", () => {
  for (const path of pages) {
    const html = read(path);
    assert.match(html, /aria-label="站点导航"/);
    assert.match(html, /href="\/"/);
    assert.match(html, /href="\/whois"/);
    assert.match(html, /href="\/contact"/);
    assert.match(html, /Who<em>IP<\/em>/);
    assert.equal(html.includes("IP<em>.</em>Lookup"), false, path);
  }
  const contact = read("public/contact/index.html");
  assert.equal(/<form\b/i.test(contact), false);
  assert.equal(contact.includes("/api/contact"), false);
  assert.match(contact, /mailto:hello@example.com/);
  assert.match(read("public/whois/index.html"), /\/api\/whois\//);
  assert.match(read("public/index.html"), /id="barMe"/);
});

test("function routes cover whoami, the whois proxy and the contact config", () => {
  const routes = JSON.parse(read("public/_routes.json"));
  for (const path of ["/", "/json", "/api/whoami", "/api/whois", "/api/whois/*", "/api/site"]) {
    assert.ok(routes.include.includes(path), path);
  }
});
