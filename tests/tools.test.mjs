// Runs webmcp.js against rendered pages in a DOM (linkedom) with a stand-in document.modelContext,
// then calls every tool. Usage: node tests/tools.test.mjs [_site]
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { parseHTML, DOMParser } from "linkedom";

const dir = path.resolve(process.argv[2] || "_site");
const ORIGIN = "https://example.test";
const script = fs.readFileSync(new URL("../_extensions/webmcp/webmcp.js", import.meta.url), "utf8");

async function fakeFetch(url) {
  const u = new URL(url);
  let file = path.join(dir, decodeURIComponent(u.pathname));
  if (file.endsWith(path.sep) || u.pathname.endsWith("/")) file = path.join(file, "index.html");
  if (!fs.existsSync(file)) return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
  const body = fs.readFileSync(file, "utf8");
  return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
}

// Loads one page, runs webmcp.js in it, and returns its window.
function open(pagePath, { webmcp = true, rejectTool = null } = {}) {
  const html = fs.readFileSync(path.join(dir, pagePath), "utf8");
  const { document } = parseHTML(html);
  const window = {}; // linkedom's window falls back to globalThis, which would leak siteTools between pages
  const registered = [];
  const navigator = {};
  if (webmcp) {
    document.modelContext = {
      registerTool(tool) {
        if (tool.name === rejectTool) throw new Error("rejected");
        assert.equal(typeof tool.execute, "function");
        assert.equal(typeof tool.description, "string");
        registered.push(tool.name);
      },
    };
  }
  const url = new URL(pagePath.replace(/index\.html$/, ""), ORIGIN + "/");
  const location = { href: url.href, origin: url.origin, pathname: url.pathname };
  const ctx = vm.createContext({
    window, document, navigator, location, console, URL, DOMParser,
    fetch: fakeFetch,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
  });
  document.dispatchEvent = () => true;
  vm.runInContext(script, ctx);
  return { window, document, registered, navigator };
}

const call = async (win, name, input) => JSON.parse(await win.siteTools.call(name, input));
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- Home page -----------------------------------------------------------------------------
{
  const { window: w, document: d, registered, navigator } = open("index.html");
  await tick();
  const SITE_TOOLS = ["about_this_website", "get_current_page", "list_pages", "get_page", "list_posts", "get_post", "search_site"];
  assert.deepEqual(registered, SITE_TOOLS, "site tools registered, no post tools on the home page");
  assert.equal(d.documentElement.getAttribute("data-webmcp"), "registered");
  assert.equal(navigator.modelContext, d.modelContext, "navigator alias");

  const about = await call(w, "about_this_website", {});
  assert.equal(about.site, "quarto-webmcp example", "site name from the index");
  assert.equal(about.owner, "AJ Wiebe");
  assert.equal(about.about, ORIGIN + "/about.html");
  assert.ok(about.pages.some((p) => p.title === "About"), "about lists pages");
  assert.equal(about.latestPosts[0].title, "Blog posts that answer agents back");

  const current = await call(w, "get_current_page");
  assert.equal(current.url, ORIGIN + "/");
  assert.ok(current.sections.some((s) => s.heading === "Try it"), "current page sections");

  const pageAbout = await call(w, "get_page", { page: "about" });
  assert.equal(pageAbout.title, "About");
  assert.ok(pageAbout.sections.some((s) => s.heading === "Why"));
  assert.equal((await call(w, "get_page", '{"page":"About"}')).title, "About", "JSON-string input");

  const posts = await call(w, "list_posts");
  assert.equal(posts.posts.length, 1);
  assert.equal(posts.posts[0].url, ORIGIN + "/posts/agent-readable-posts/");

  for (const q of ["answer agents", "agent-readable-posts", "Blog posts that answer agents back"]) {
    const post = await call(w, "get_post", { post: q });
    assert.equal(post.agent.claims.length, 2, `get_post(${q})`);
  }
  assert.match((await call(w, "get_post", { post: "nope" })).error, /No post matches/);

  const search = await call(w, "search_site", { query: "Scholarly" });
  assert.equal(search.matches.length, 1);
  assert.match(search.matches[0].excerpt, /Scholarly articles/);

  const bad = await call(w, "get_page", { pag: 1 });
  assert.match(bad.error, /unknown parameter "pag".*missing required parameter "page"/);
  assert.deepEqual(bad.example, { page: "…" });
  assert.match((await call(w, "nope", {})).error, /Unknown tool/);
}

// ---- Post page -----------------------------------------------------------------------------
{
  const { window: w, registered } = open("posts/agent-readable-posts/index.html");
  await tick();
  for (const t of ["get_post_summary", "check_post_fit", "get_post_credibility", "get_post_claims", "get_post_context", "get_post_next_steps"]) {
    assert.ok(registered.includes(t), `post tool ${t}`);
  }
  const POST = ORIGIN + "/posts/agent-readable-posts/";

  const one = await call(w, "get_post_summary", { depth: "one_line" });
  assert.match(one.thesis, /serve human readers and AI agents/);
  assert.equal(one.takeaways, undefined);
  const outline = await call(w, "get_post_summary", { depth: "outline" });
  assert.equal(outline.outline[1].url, POST + "#how-it-works");
  assert.match((await call(w, "get_post_summary", { depth: "full" })).error, /must be one of/);

  const fit = await call(w, "check_post_fit", { role: "blogger" });
  assert.equal(fit.reader.role, "blogger");
  assert.ok(fit.goodFitIf.length > 0);

  const cred = await call(w, "get_post_credibility");
  assert.equal(cred.author.name, "AJ Wiebe");
  assert.equal(cred.author.about, ORIGIN + "/about.html");
  assert.match(cred.disclosures[0], /^None/);

  const claims = await call(w, "get_post_claims", {});
  assert.equal(claims.claims[1].evidence.link, POST + "#how-it-works");
  assert.equal((await call(w, "get_post_claims", { claim_id: "c1" })).evidence.type, "opinion");
  assert.deepEqual((await call(w, "get_post_claims", { claim_id: "c9" })).claimIds, ["c1", "c2"]);

  const context = await call(w, "get_post_context");
  assert.equal(context.sources.builds_on.length, 1);

  const next = await call(w, "get_post_next_steps");
  assert.match(next.nextSteps[0].link, /quarto-webmcp#install$/);
}

// ---- Fallbacks -----------------------------------------------------------------------------
{
  const { window: w, document: d, registered } = open("about.html", { webmcp: false });
  await tick();
  assert.equal(registered.length, 0);
  assert.equal(d.documentElement.getAttribute("data-webmcp"), "unavailable");
  assert.equal((await call(w, "get_current_page")).title, "About", "siteTools works without WebMCP");

  const partial = open("index.html", { rejectTool: "search_site" });
  await tick();
  await tick();
  assert.equal(partial.document.documentElement.getAttribute("data-webmcp"), "partial");
  assert.deepEqual([...partial.window.siteTools.webmcp.failed], ["search_site"]);
}

console.log("ok: all tool checks passed");
