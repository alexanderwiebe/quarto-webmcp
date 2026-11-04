// Checks a rendered example site: every page carries webmcp data, the index and llms.txt exist,
// and the post's agent data made it through intact. Usage: node tests/check-site.mjs [_site]
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const dir = process.argv[2] || "_site";
const read = (p) => fs.readFileSync(path.join(dir, p), "utf8");
const DATA_RE = /<script type="application\/json" id="webmcp-data">([\s\S]*?)<\/script>/;

for (const page of ["index.html", "about.html", "posts/index.html", "posts/agent-readable-posts/index.html"]) {
  const html = read(page);
  const m = html.match(DATA_RE);
  assert.ok(m, `${page}: missing webmcp-data`);
  const data = JSON.parse(m[1]);
  assert.equal(data.site.owner, "AJ Wiebe", `${page}: site settings`);
  assert.match(html, /webmcp\.js/, `${page}: webmcp.js not attached`);
}

const post = JSON.parse(read("posts/agent-readable-posts/index.html").match(DATA_RE)[1]);
assert.equal(post.page.kind, "post");
assert.equal(post.root, "../..");
assert.equal(post.page.agent.claims.length, 2);
assert.equal(post.page.agent.claims[0].evidence.type, "opinion");
assert.deepEqual(post.page.outline.map((s) => s.anchor), ["#the-questions-every-post-gets-asked", "#how-it-works", "#what-this-doesnt-do"]);

const listing = JSON.parse(read("posts/index.html").match(DATA_RE)[1]);
assert.equal(listing.page.kind, "page", "the posts listing is not a post");

const index = JSON.parse(read("webmcp-index.json"));
const byPath = Object.fromEntries(index.pages.map((p) => [p.path, p]));
assert.ok(byPath["./"], "index: home page");
assert.ok(byPath["about.html"], "index: about page");
assert.equal(byPath["posts/agent-readable-posts/"].kind, "post");
assert.match(byPath["posts/agent-readable-posts/"].text, /Scholarly articles answer these/);

const llms = read("llms.txt");
assert.match(llms, /^# quarto-webmcp example/);
assert.match(llms, /\[Blog posts that answer agents back\]\(posts\/agent-readable-posts\/\)/);

console.log(`ok: ${index.pages.length} pages indexed`);
