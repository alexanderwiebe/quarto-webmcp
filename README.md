# quarto-webmcp

A [Quarto](https://quarto.org) extension that exposes a website's content to in-browser AI agents through
[WebMCP](https://developer.chrome.com/docs/ai/webmcp). In a browser that supports WebMCP, every page
registers tools an agent can call instead of clicking around and reading the screen. In every other
browser nothing visible changes.

It does two things:

- **Site tools on every page:** what the site is, its pages and posts, any page's content, and search.
- **Post tools on blog posts:** an `agent:` block in a post's frontmatter becomes tools that answer the
  questions readers ask of any post: what is it, is it for me, can I trust it, what does it claim and on
  what evidence, how does it fit with other work, and what to do next.

Both come from the same `.qmd` files people read, so they can't drift apart.

Extracted from [systemsbyaj.com](https://systemsbyaj.com)
([alexanderwiebe/alexanderwiebe.github.io#6](https://github.com/alexanderwiebe/alexanderwiebe.github.io/pull/6)).

## Install

```bash
quarto add alexanderwiebe/quarto-webmcp
```

Pin a release with `quarto add alexanderwiebe/quarto-webmcp@v0.2.0`.

Then add the filter and the post-render script to `_quarto.yml`:

```yaml
project:
  type: website
  post-render: _extensions/alexanderwiebe/webmcp/webmcp-index.ts

filters:
  - webmcp
```

The filter is enough for the tools to register. The post-render script writes `webmcp-index.json`
(and `llms.txt`), which the site-wide tools (`list_pages`, `get_page`, `list_posts`, `get_post`,
`search_site`) need to see beyond the current page.

## Settings

All optional, under `webmcp:` in `_quarto.yml` (or in one page's frontmatter):

```yaml
webmcp:
  name: "AJ Wiebe"                  # default: website.title
  description: "What the site is."  # default: website.description
  owner: "AJ Wiebe, Principal Consultant"
  site-url: "https://example.com"   # default: website.site-url; used for absolute links in llms.txt
  about: about.html                 # page about the author, linked from post tools
  source: "https://github.com/you/site"   # default: website.repo-url
  links: { github: "https://github.com/you", linkedin: "https://www.linkedin.com/in/you" }
  posts: posts                      # folder whose pages count as posts (default: posts)
  theme:                            # add a set_theme tool that clicks your own theme controls
    light: "[data-theme-btn=light]"
    dark: "[data-theme-btn=dark]"
  content:                          # for custom layouts: where content is, how it splits into sections
    root: ".wrap"                   # default: "#quarto-document-content, main"
    heading: ".section-label, h2"   # default: "h2"
    skip: ".masthead, .crumb"       # elements left out of get_current_page and get_page
  origin-trials:                    # WebMCP origin-trial tokens, added to every page's <head>
    - "AgKG...="
  index: true                       # false: site tools only look at the current page
  enabled: true                     # false on a page: no tools on that page
```

With a Quarto light/dark theme (`theme: {light: ..., dark: ...}`), `set_theme` uses Quarto's own toggle
and needs no `theme:` setting.

Draft pages (`draft: true`) get tools when they are rendered but are left out of the index and `llms.txt`.

## Tools

| Tool | Where | Returns |
|---|---|---|
| `about_this_website` | every page | Owner, purpose, every page with a description, latest posts, the current page, the other tools |
| `get_current_page` | every page | The open page as structured sections, read from the page with no fetch |
| `list_pages` | every page | Every page except posts, with description and URL |
| `get_page(page)` | every page | Any page's content as sections; accepts a title, part of a title, a slug or a path |
| `list_posts` | every page | Posts, newest first |
| `get_post(post)` | every page | One post's structured data: thesis, audience, claims and evidence, limitations, sources, dates |
| `search_site(query)` | every page | Matching pages with a short excerpt |
| `set_theme(light\|dark)` | when a theme toggle exists | Switches the color theme |
| `get_post_summary(depth)` | posts | Thesis, takeaways, outline |
| `check_post_fit(role, situation, goal)` | posts | Who the post is and isn't for, prerequisites, limitations |
| `get_post_credibility` | posts | Author experience, dates, versions tested, known-outdated parts, disclosures |
| `get_post_claims(claim_id)` | posts | Each claim with its evidence type, detail and link |
| `get_post_context` | posts | Sources it builds on, supports or contradicts; related posts |
| `get_post_next_steps` | posts | Concrete next steps with links, and limitations |

Every tool except `set_theme` is marked `readOnlyHint: true`. Bad input and failures come back as
`{error, ...}` data with the expected schema or fallback URLs, never as a thrown error, so agents don't
give up on the tools and go back to browsing.

## Writing an agent-readable post

Every `agent:` field is optional. Leave out what doesn't apply; the tools return empty lists.

```yaml
---
title: "We cut CI time 60% by dropping Docker layer caching"
description: "One-line description."
date: 2026-11-04
date-modified: 2026-11-04

agent:
  summary: "The thesis in one sentence."
  takeaways:
    - "What a reader should remember."
  audience:
    for: ["Platform engineers", "Teams whose CI takes over 20 minutes"]
    not_for: ["Monorepos built with Bazel"]
    prerequisites: ["GitHub Actions", "Basic Docker"]
  author_experience: "What the author has done hands-on that this post draws on."
  tested_against: { github_actions: "2026-09", docker: "27.x" }
  outdated: []              # sections the author knows no longer hold
  disclosures: []           # sponsorships, affiliate links, products sold
  claims:
    - id: c1
      claim: "Layer caching added about 4 minutes per run on cold runners."
      evidence: { type: measured, detail: "120 runs before and after", link: "#benchmarks" }
    - id: c2
      claim: "Most teams don't benefit from layer caching."
      evidence: { type: opinion, detail: "From 4 codebases; not generalizable." }
  sources:
    - { title: "Docker build cache docs", url: "https://docs.docker.com/build/cache/", relation: background }
  related: []               # slugs of other posts in the posts folder
  limitations:
    - "Doesn't apply to self-hosted runners with persistent disks."
  next_steps:
    - { action: "Copy the workflow file", link: "ci.yml" }
---
```

The render fails, naming the file and field, when:

- a claim is missing `id`, `claim` or `evidence`, or two claims share an `id`;
- `evidence.type` isn't `measured`, `experienced`, `cited` or `opinion`;
- a source has no `url`, or its `relation` isn't `supports`, `contradicts`, `builds-on` or `background`.

Links can be `#anchor` (a heading in the post), a path relative to the post, or a full URL.
Any page with an `agent:` block gets the post tools, even outside the posts folder.

## Adding your own tools

Site-specific tools go through the same registration, validation and error handling:

```html
<script>
document.addEventListener('webmcp:ready', function (e) {
  e.detail.add([{
    name: 'list_projects',
    description: 'Lists the projects on this site.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: async function () {
      const index = await window.siteTools.index();
      return { projects: index.pages.filter(p => p.path.startsWith('projects/')) };
    }
  }]);
});
</script>
```

Include it with `include-after-body`. `execute` can return an object (it is turned into JSON) or a string.

`window.siteTools` also has helpers for writing tools:

| Helper | Does |
|---|---|
| `index()` | Promise of the parsed `webmcp-index.json` (each page has `url`, `path`, `title`, `kind`, `agent`...), or `null` |
| `loadPage(url)` | Promise of a fetched page as a `Document` (cached; the current page returns `document`) |
| `pageContent(doc, url)` | `{title, url, description, published, sections}` for a page |
| `sections(doc)` | The page split at each heading: `[{heading, items: [text...]}]` |
| `text(el)` | An element's visible text, whitespace collapsed |
| `findPage(pages, query)` | Best match by exact title, slug or path, then partial match |
| `absUrl(path)` | A site-root-relative path as an absolute URL |
| `json(value)` | Pretty-printed JSON string |

## Checking it

In the browser console on any page:

```js
window.siteTools.list().map(t => t.name)
JSON.parse(await window.siteTools.call('get_post_claims', {}))
document.documentElement.dataset.webmcp   // registered, partial, failed or unavailable
```

`window.siteTools` works in every browser, so agents that can run page JavaScript but don't support
WebMCP still get structured answers. When the browser exposes WebMCP only on `document.modelContext`,
`navigator.modelContext` is pointed at the same object for older agents. Nothing is created in
browsers without WebMCP.

## Compatibility

- **Quarto 1.4 or newer.** CI renders the example site with the current release and pre-release.
- **Quarto 2** (`q2`, experimental) is not tested yet. The filter uses only Pandoc Lua APIs that q2
  documents as supported, and no EJS templates.
- **WebMCP** is an early Chrome and Edge feature. Turn it on locally with the WebMCP flag, or register
  for the origin trials and list the tokens under `webmcp.origin-trials`.

## Developing

This repository is itself a Quarto website that uses the extension from `_extensions/webmcp/`:

```bash
quarto preview
```

```bash
quarto render && npm install && npm test
```

## License

MIT
