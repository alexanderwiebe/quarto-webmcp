// Checks example.qmd rendered on its own, outside a website project, the way someone trying the
// extension would: `quarto add alexanderwiebe/quarto-webmcp` then `quarto render example.qmd`.
// There is no webmcp-index.json there, so this also covers the single-document case.
// Usage: node tests/example.test.mjs path/to/example.html
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { parseHTML, DOMParser } from "linkedom";

const file = process.argv[2];
assert.ok(file, "usage: node tests/example.test.mjs path/to/example.html");
const html = fs.readFileSync(file, "utf8");

const tags = html.match(/<script type="application\/json" id="webmcp-data">([\s\S]*?)<\/script>/g) || [];
assert.equal(tags.length, 1, "exactly one webmcp-data element");
const data = JSON.parse(tags[0].replace(/^<script[^>]*>|<\/script>$/g, ""));
assert.equal(data.site.name, "quarto-webmcp example");
assert.equal(data.page.kind, "post", "an agent: block makes the page a post");
assert.equal(data.page.agent.claims.length, 2);
assert.deepEqual([...data.page.outline.map((s) => s.anchor)], ["#try-it", "#how-it-works", "#in-a-website"]);
assert.equal(html.match(/webmcp\.js/g).length, 1, "webmcp.js attached once");

const script = fs.readFileSync(new URL("../_extensions/webmcp/webmcp.js", import.meta.url), "utf8");
const { document } = parseHTML(html);
const registered = [];
document.modelContext = { registerTool: (tool) => registered.push(tool.name) };
document.dispatchEvent = () => true;
const window = {};
const ORIGIN = "https://example.test";
vm.runInContext(script, vm.createContext({
  window, document, navigator: {}, console, URL, DOMParser,
  location: { href: ORIGIN + "/example.html", origin: ORIGIN, pathname: "/example.html" },
  fetch: async () => ({ ok: false, status: 404, text: async () => "", json: async () => ({}) }),
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
}));
await new Promise((r) => setTimeout(r, 0));

for (const t of ["about_this_website", "get_current_page", "get_post_summary", "check_post_fit", "get_post_credibility", "get_post_claims", "get_post_context", "get_post_next_steps"]) {
  assert.ok(registered.includes(t), `registered ${t}`);
}
assert.equal(document.documentElement.getAttribute("data-webmcp"), "registered");

const call = async (name, input = {}) => JSON.parse(await window.siteTools.call(name, input));
assert.equal((await call("about_this_website")).site, "quarto-webmcp example");
assert.ok((await call("get_current_page")).sections.some((s) => s.heading === "How it works"));
assert.match((await call("get_post_summary", { depth: "one_line" })).thesis, /registers WebMCP tools/);
const claims = await call("get_post_claims");
assert.equal(JSON.stringify(claims).includes("Not yet measured"), true, "claim evidence returned");
assert.equal((await call("get_post_credibility")).author.name, "AJ Wiebe");

console.log(`ok: example.qmd registers ${registered.length} tools`);
