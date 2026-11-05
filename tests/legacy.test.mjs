// Checks tests/legacy.qmd rendered on its own: settings and `agent:` in the pre-0.3 top-level
// places still work, and `extensions: webmcp:` wins key by key. Usage: node tests/legacy.test.mjs path/to/legacy.html
import fs from "node:fs";
import assert from "node:assert/strict";

const html = fs.readFileSync(process.argv[2], "utf8");
const data = JSON.parse(html.match(/<script type="application\/json" id="webmcp-data">([\s\S]*?)<\/script>/)[1]);
assert.equal(data.site.name, "New name", "extensions.webmcp wins");
assert.equal(data.site.owner, "Legacy owner", "top-level webmcp still read");
assert.equal(data.site.agent, undefined, "agent is not a site setting");
assert.equal(data.page.kind, "post");
assert.equal(data.page.agent.summary, "Top-level agent block.");
assert.equal(data.page.agent.claims[0].id, "c1");
console.log("ok: top-level webmcp and agent still work");
