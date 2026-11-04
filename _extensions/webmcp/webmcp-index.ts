// quarto-webmcp post-render script: builds the site index the WebMCP tools read.
//
// Add it to _quarto.yml:
//   project:
//     post-render: _extensions/alexanderwiebe/webmcp/webmcp-index.ts
//
// Reads the <script id="webmcp-data"> block webmcp.lua embeds in every rendered page and writes:
//   <output-dir>/webmcp-index.json   every page and post, with its text for search_site
//   <output-dir>/llms.txt            a page list for agents that read before acting (skipped when
//                                    the site already publishes its own llms.txt)
//
// Uses only node: modules, so it runs under Quarto's Deno and under Node (node webmcp-index.ts <dir>).

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const MAX_TEXT = 20000;

const outDir = process.argv[2] || process.env.QUARTO_PROJECT_OUTPUT_DIR;
if (!outDir) {
  console.error("webmcp-index: QUARTO_PROJECT_OUTPUT_DIR is not set; pass the output directory as an argument.");
  process.exit(1);
}

// deno-lint-ignore no-explicit-any
type Json = any;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "site_libs" || entry.name.startsWith(".")) continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".html")) {
      out.push(full);
    }
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? ENTITIES[e] ?? m;
  });
}

// Visible text of the page's main content, for search_site excerpts.
function mainText(html: string): string {
  const start = html.search(/<main\b/i);
  const end = html.search(/<\/main>/i);
  let body = start !== -1 && end > start ? html.slice(start, end) : html;
  body = body
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return decode(body).replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}

const DATA_RE = /<script type="application\/json" id="webmcp-data">([\s\S]*?)<\/script>/;

let site: Json = null;
const pages: Json[] = [];

for (const file of walk(outDir).sort()) {
  const html = fs.readFileSync(file, "utf8");
  const match = html.match(DATA_RE);
  if (!match) continue;
  let data: Json;
  try {
    data = JSON.parse(match[1]);
  } catch (err) {
    console.warn(`webmcp-index: skipping ${file}: invalid webmcp-data JSON (${err})`);
    continue;
  }
  const page = data.page || {};
  if (page.draft) continue;
  site = site || data.site;
  const rel = path.relative(outDir, file).split(path.sep).join("/");
  pages.push({
    path: rel.replace(/(^|\/)index\.html$/, "$1") || "./",
    title: page.title || rel,
    description: page.description || null,
    kind: page.kind || "page",
    author: page.author || null,
    published: page.published || null,
    updated: page.updated || null,
    outline: page.outline || [],
    agent: page.agent || null,
    text: mainText(html),
  });
}

if (!site) {
  console.warn("webmcp-index: no rendered page has webmcp data. Is `filters: [webmcp]` in _quarto.yml?");
  process.exit(0);
}

// Lua filters can't read the `website:` settings, so fill the site name and description from the
// rendered home page: its og:site_name or navbar title, and its description.
if (!site.name || !site.description) {
  const homeFile = path.join(outDir, "index.html");
  const home = fs.existsSync(homeFile) ? fs.readFileSync(homeFile, "utf8") : "";
  const ogName = home.match(/<meta property="og:site_name" content="([^"]*)"/);
  const navTitle = home.match(/<span class="navbar-title">([\s\S]*?)<\/span>/);
  site.name = site.name || (ogName && decode(ogName[1])) || (navTitle && decode(navTitle[1].replace(/<[^>]+>/g, "")).trim()) || null;
  const homePage = pages.find((p) => p.path === "./");
  site.description = site.description || (homePage && homePage.description) || null;
}

const index = { generator: `quarto-webmcp ${site.version || ""}`.trim(), generated: new Date().toISOString(), site, pages };
fs.writeFileSync(path.join(outDir, "webmcp-index.json"), JSON.stringify(index));

// llms.txt: only when the site doesn't ship its own.
const llmsPath = path.join(outDir, "llms.txt");
const ownLlms = fs.existsSync(llmsPath) && !fs.readFileSync(llmsPath, "utf8").includes("<!-- quarto-webmcp -->");
if (!ownLlms) {
  const base = site.url ? String(site.url).replace(/\/?$/, "/") : "";
  const link = (p: Json) => `- [${p.title}](${p.path === "./" ? base || "./" : base + p.path})${p.description ? `: ${p.description}` : ""}`;
  const regular = pages.filter((p) => p.kind !== "post").sort((a, b) => (a.path === "./" ? -1 : b.path === "./" ? 1 : 0));
  const posts = pages.filter((p) => p.kind === "post")
    .sort((a, b) => String(b.published || "").localeCompare(String(a.published || "")));
  const lines = [
    `# ${site.name || "Site"}`,
    "",
    ...(site.description ? [`> ${site.description}`, ""] : []),
    "## Pages",
    "",
    ...regular.map(link),
    ...(posts.length ? ["", "## Posts", "", ...posts.map(link)] : []),
    "",
    "## WebMCP tools",
    "",
    "Every page registers WebMCP tools (document.modelContext) in browsers that support it, and exposes the same tools to",
    "page JavaScript as window.siteTools.call(name, input). They return the site's content as structured JSON:",
    "about_this_website, get_current_page, list_pages, get_page, list_posts, get_post, search_site.",
    "Post pages also register get_post_summary, check_post_fit, get_post_credibility, get_post_claims,",
    "get_post_context and get_post_next_steps.",
    "",
    `The full index is at ${base}webmcp-index.json.`,
    "",
    "<!-- quarto-webmcp -->",
    "",
  ];
  fs.writeFileSync(llmsPath, lines.join("\n"));
}

console.log(`webmcp-index: indexed ${pages.length} pages${ownLlms ? "" : " and wrote llms.txt"}`);
