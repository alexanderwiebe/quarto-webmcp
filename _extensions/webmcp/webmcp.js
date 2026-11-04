// quarto-webmcp runtime: registers a Quarto site's content as WebMCP tools for in-browser AI agents.
// https://github.com/alexanderwiebe/quarto-webmcp
//
// Reads <script id="webmcp-data"> (written by webmcp.lua) and, when present, the site index
// webmcp-index.json (written by webmcp-index.ts after the render).
//
// The same tools are callable from page JavaScript in every browser, with or without WebMCP:
//   window.siteTools.list()                    -> names, descriptions, input schemas
//   await window.siteTools.call(name, input)   -> JSON string, same as the WebMCP result
//   window.siteTools.add([tool, ...])          -> register your own site-specific tools
//   window.siteTools.webmcp                    -> which API registered the tools, and any failures
// <html data-webmcp="..."> shows the status: pending, registered, partial, failed or unavailable.
//
// Site scripts that add their own tools should wait for the `webmcp:ready` event on document
// (or check window.siteTools first), since this script runs at the end of <body>.
(function () {
  if (document.readyState === 'loading' && !document.getElementById('webmcp-data')) {
    document.addEventListener("DOMContentLoaded", quartoWebmcpInit);
  } else {
    quartoWebmcpInit();
  }
})();

function quartoWebmcpInit() {
  if (window.siteTools && window.siteTools.__quartoWebmcp) return;

  // ---------------------------------------------------------------------------------------------
  // Registration core
  // ---------------------------------------------------------------------------------------------

  var api = document.modelContext ? 'document.modelContext' : navigator.modelContext ? 'navigator.modelContext' : null;
  var mc = document.modelContext || navigator.modelContext;
  var canRegister = !!(mc && typeof mc.registerTool === 'function');

  // Older agents probe navigator.modelContext. When the browser provides the API only on
  // document, point navigator at the same real object. Never created when WebMCP is absent.
  if (document.modelContext && !('modelContext' in navigator)) {
    try {
      Object.defineProperty(navigator, 'modelContext', { value: document.modelContext, configurable: true });
    } catch (e) {}
  }

  // Chrome versions disagree on whether executeTool(name, input) takes input as an object or a JSON
  // string, and reject the other form before the tool runs. Retry once with the other form.
  if (mc && typeof mc.executeTool === 'function' && !mc.executeTool.__siteShim) {
    var nativeExecute = mc.executeTool;
    var shim = function (name, input) {
      var self = this;
      var rest = Array.prototype.slice.call(arguments, 2);
      var call = function (arg) { return nativeExecute.apply(self, [name, arg].concat(rest)); };
      return Promise.resolve().then(function () { return call(input); }).catch(function (err) {
        if (typeof input === 'string') {
          var parsed;
          try { parsed = JSON.parse(input); } catch (e) { throw err; }
          return call(parsed);
        }
        if (input && typeof input === 'object') return call(JSON.stringify(input));
        throw err;
      });
    };
    shim.__siteShim = true;
    try { mc.executeTool = shim; } catch (e) {}
  }

  function json(data) {
    return JSON.stringify(data, null, 2);
  }

  function exampleInput(schema) {
    var props = (schema && schema.properties) || {};
    var out = {};
    Object.keys(props).forEach(function (key) {
      var p = props[key];
      out[key] = p.enum ? p.enum[0] : p.type === 'number' || p.type === 'integer' ? 0 : p.type === 'boolean' ? false : '…';
    });
    return out;
  }

  // Accepts an object, a JSON string of an object, or nothing (= {}), and checks it against the
  // tool's inputSchema: unknown keys, missing required keys, wrong types and values outside an enum.
  function parseInput(tool, input) {
    var schema = tool.inputSchema || { type: 'object', properties: {} };
    var problems = [];
    if (input === undefined || input === null || input === '') input = {};
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch (e) { problems.push('input is a string but not valid JSON (' + e.message + ')'); }
    }
    if (!problems.length && (typeof input !== 'object' || input === null || Array.isArray(input))) {
      problems.push('input must be an object, got ' + (Array.isArray(input) ? 'an array' : input === null ? 'null' : typeof input));
    }
    if (!problems.length) {
      var props = schema.properties || {};
      Object.keys(input).forEach(function (key) {
        var p = props[key];
        var value = input[key];
        if (!p) {
          problems.push('unknown parameter "' + key + '"');
        } else if (value !== undefined && value !== null) {
          var actual = Array.isArray(value) ? 'array' : typeof value;
          var expected = p.type === 'integer' ? 'number' : p.type;
          if (expected && actual !== expected) {
            problems.push('"' + key + '" must be a ' + p.type + ', got ' + actual);
          } else if (p.enum && p.enum.indexOf(value) === -1) {
            problems.push('"' + key + '" must be one of ' + JSON.stringify(p.enum) + ', got ' + JSON.stringify(value));
          }
        }
      });
      (schema.required || []).forEach(function (key) {
        if (input[key] === undefined || input[key] === null || input[key] === '') problems.push('missing required parameter "' + key + '"');
      });
    }
    if (!problems.length) return { input: input };
    return {
      error: json({
        error: 'Invalid input for ' + tool.name + ': ' + problems.join('; ') + '.',
        expected: 'A plain JSON object matching inputSchema (not a JSON string, array or other value).',
        inputSchema: schema,
        example: exampleInput(schema)
      })
    };
  }

  var fallbackUrls = function () { return [location.href]; };

  // A failed call returns an error the agent can act on, instead of throwing, so the agent doesn't
  // decide the tools are broken and go back to browsing.
  function safe(tool) {
    var execute = tool.execute;
    return function (input) {
      var parsed = parseInput(tool, input);
      if (parsed.error) return Promise.resolve(parsed.error);
      return Promise.resolve().then(function () { return execute(parsed.input); }).then(function (result) {
        return typeof result === 'string' ? result : json(result);
      }).catch(function (err) {
        return json({
          error: String((err && err.message) || err),
          fallback: 'The content is still available as web pages: ' + fallbackUrls().join(', ')
        });
      });
    };
  }

  var wrapped = [];
  var status = { api: canRegister ? api : null, registered: [], failed: [] };
  var root = document.documentElement;
  var pending = Promise.resolve();

  function addTools(newTools) {
    var names = wrapped.map(function (t) { return t.name; });
    var added = newTools.filter(function (tool) {
      if (names.indexOf(tool.name) === -1) return true;
      console.warn('WebMCP: a tool named ' + tool.name + ' is already registered; skipping the new one');
      return false;
    }).map(function (tool) {
      return Object.assign({ inputSchema: { type: 'object', properties: {} } }, tool, { execute: safe(tool) });
    });
    wrapped.push.apply(wrapped, added);
    if (!canRegister) {
      root.setAttribute('data-webmcp', 'unavailable');
      return pending;
    }
    root.setAttribute('data-webmcp', 'pending');
    pending = pending.then(function () {
      return Promise.all(added.map(function (tool) {
        return Promise.resolve().then(function () { return mc.registerTool(tool); }).then(function () {
          status.registered.push(tool.name);
        }, function (err) {
          status.failed.push(tool.name);
          console.warn('WebMCP: could not register ' + tool.name, err);
        });
      }));
    }).then(function () {
      root.setAttribute('data-webmcp', !status.failed.length ? 'registered' : status.registered.length ? 'partial' : 'failed');
    });
    return pending;
  }

  // ---------------------------------------------------------------------------------------------
  // Site data
  // ---------------------------------------------------------------------------------------------

  var dataEl = document.getElementById('webmcp-data');
  var data = { site: {}, page: {}, root: '.' };
  if (dataEl) {
    try { data = JSON.parse(dataEl.textContent); } catch (e) { console.warn('WebMCP: page data is not valid JSON', e); }
  }
  var site = data.site || {};
  var page = data.page || {};
  var agent = page.agent || {};
  var rootUrl = new URL((data.root || '.').replace(/\/?$/, '/'), location.href).href;
  var pageUrl = prettyUrl(location.href);

  function clean(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function list(x) {
    return Array.isArray(x) ? x : [];
  }

  // Root-relative paths ("about.html") resolve against the site root; full URLs are unchanged.
  function absUrl(href) {
    if (!href) return null;
    return new URL(href, rootUrl).href;
  }

  // "#anchor" -> this page's anchor; relative paths -> relative to this page; full URLs unchanged.
  function pageLink(href) {
    if (!href) return null;
    return href.charAt(0) === '#' ? pageUrl + href : new URL(href, location.href).href;
  }

  function prettyUrl(href) {
    var u = new URL(href, location.href);
    u.hash = '';
    u.search = '';
    return u.href.replace(/index\.html$/, '');
  }

  function text(el) {
    if (!el) return '';
    var copy = el.cloneNode(true);
    copy.querySelectorAll('svg, script, style, .anchorjs-link, .visually-hidden').forEach(function (n) { n.remove(); });
    copy.querySelectorAll('br').forEach(function (n) { n.replaceWith(' '); });
    return clean(copy.textContent);
  }

  var indexPromise = null;
  function loadIndex() {
    if (site.index === false) return Promise.resolve(null);
    if (!indexPromise) {
      indexPromise = fetch(absUrl('webmcp-index.json'), { credentials: 'same-origin' }).then(function (res) {
        if (!res.ok) throw new Error('webmcp-index.json: HTTP ' + res.status);
        return res.json();
      }).then(function (index) {
        index.pages.forEach(function (p) { p.url = absUrl(p.path); });
        return index;
      }).catch(function (err) {
        console.warn('WebMCP: no site index, so site-wide tools only see this page.', err);
        indexPromise = null;
        return null;
      });
    }
    return indexPromise;
  }

  fallbackUrls = function () { return [pageUrl, rootUrl]; };

  var pageCache = {};
  function loadPage(url) {
    var key = prettyUrl(url);
    if (key === pageUrl) return Promise.resolve(document);
    if (!pageCache[key]) {
      pageCache[key] = fetch(url, { credentials: 'same-origin' }).then(function (res) {
        if (!res.ok) throw new Error('Could not load ' + url + ' (HTTP ' + res.status + ')');
        return res.text();
      }).then(function (html) {
        return new DOMParser().parseFromString(html, 'text/html');
      });
      pageCache[key].catch(function () { delete pageCache[key]; });
    }
    return pageCache[key];
  }

  // Where page content lives and how it splits into sections. Sites with their own layout set
  // `webmcp.content` (root, heading and skip selectors) in _quarto.yml.
  var content = Object.assign({
    root: '#quarto-document-content, main',
    heading: 'h2',
    skip: '#title-block-header, header, nav, script, style, svg, .quarto-listing, #quarto-margin-sidebar'
  }, site.content || {});

  function contentRoot(doc) {
    return doc.querySelector(content.root) || doc.querySelector('main') || doc.body;
  }

  // Children of el, flattening the <section> wrappers Quarto puts around headings and any other
  // wrapper that contains a heading.
  function flatChildren(el) {
    return Array.prototype.reduce.call(el.children, function (all, child) {
      var wrapper = child.matches('section') || (!child.matches(content.heading) && !child.matches(content.skip) &&
        child.querySelector(content.heading));
      return all.concat(wrapper ? flatChildren(child) : [child]);
    }, []);
  }

  // The page's content split into sections at each heading.
  function sections(doc) {
    var main = contentRoot(doc);
    var out = [];
    var current = { heading: null, items: [] };
    if (!main) return out;
    flatChildren(main).forEach(function (el) {
      if (el.matches(content.skip)) return;
      if (el.matches(content.heading)) {
        if (current.heading || current.items.length) out.push(current);
        current = { heading: text(el), items: [] };
        return;
      }
      var t = text(el);
      if (t) current.items.push(t);
    });
    if (current.heading || current.items.length) out.push(current);
    return out;
  }

  function readPageData(doc) {
    var el = doc.getElementById('webmcp-data');
    if (!el) return null;
    try { return JSON.parse(el.textContent).page || null; } catch (e) { return null; }
  }

  function pageContent(doc, url) {
    var p = readPageData(doc) || {};
    return {
      title: p.title || clean(doc.title),
      url: prettyUrl(url),
      description: p.description || null,
      published: p.published || null,
      sections: sections(doc)
    };
  }

  function summary(p) {
    var out = { title: p.title, url: p.url, description: p.description || null };
    if (p.kind === 'post') out.published = p.published || null;
    return out;
  }

  function norm(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // Exact title, slug or path first, then partial matches.
  function findPage(pages, query) {
    var q = norm(query);
    if (!q) return null;
    var slug = function (p) { return norm(p.path.replace(/(\/index)?\.html$|\/$/, '').split('/').pop()); };
    var exact = pages.filter(function (p) { return norm(p.title) === q || slug(p) === q || norm(p.path) === q; })[0];
    if (exact) return exact;
    return pages.filter(function (p) {
      var hay = slug(p) + ' ' + norm(p.title);
      return hay.indexOf(q) !== -1 || (norm(p.title) && q.indexOf(norm(p.title)) !== -1);
    })[0] || null;
  }

  function posts(index) {
    return index.pages.filter(function (p) { return p.kind === 'post'; }).sort(function (a, b) {
      return String(b.published || '').localeCompare(String(a.published || ''));
    });
  }

  var NO_INDEX = 'This site has no webmcp-index.json, so only the current page is available. ' +
    'Site owners: add the webmcp-index.ts post-render script (see the quarto-webmcp README).';

  // ---------------------------------------------------------------------------------------------
  // Site tools: on every page
  // ---------------------------------------------------------------------------------------------

  var siteName = site.name || clean(document.title);

  var tools = [
    {
      name: 'about_this_website',
      description: 'Answers general questions about this website ("what is this site?", "what can I find here?", "who runs it?"). ' +
        'Returns who the site belongs to, what it covers, every page with a one-line description, the latest posts, ' +
        'which page is open now, and the other tools available for specific questions. Returns structured data in one call.',
      annotations: { readOnlyHint: true },
      execute: function () {
        return loadIndex().then(function (index) {
          var indexed = (index && index.site) || {};
          return {
            site: site.name || indexed.name || siteName,
            url: site.url || rootUrl,
            owner: site.owner || null,
            purpose: site.description || indexed.description || null,
            about: site.about ? absUrl(site.about) : null,
            pages: index ? index.pages.filter(function (p) { return p.kind !== 'post'; }).map(summary) : null,
            latestPosts: index ? posts(index).slice(0, 5).map(summary) : null,
            note: index ? undefined : NO_INDEX,
            source: site.source || null,
            links: site.links || null,
            currentPage: { title: page.title || clean(document.title), url: pageUrl },
            tools: wrapped.map(function (t) { return { name: t.name, use: t.description.split('. ')[0].replace(/\.?$/, '.') }; }),
            toolAccess: {
              webmcp: status.api ? 'Registered via ' + status.api : 'WebMCP is not available in this browser',
              javascript: 'Call any tool from page JavaScript with await window.siteTools.call(name, input); it returns a JSON string.'
            }
          };
        });
      }
    },
    {
      name: 'get_current_page',
      description: 'Returns the full content of the page open now, as structured sections (title, description, headings, paragraphs). ' +
        'Use to summarize, explain or answer questions about "this page" without reading the screen.',
      annotations: { readOnlyHint: true },
      execute: function () {
        return pageContent(document, location.href);
      }
    },
    {
      name: 'list_pages',
      description: 'Lists every page on this website (not counting blog posts), each with title, one-line description and URL.',
      annotations: { readOnlyHint: true },
      execute: function () {
        return loadIndex().then(function (index) {
          if (!index) return { pages: [summary({ title: page.title, url: pageUrl, description: page.description })], note: NO_INDEX };
          return { pages: index.pages.filter(function (p) { return p.kind !== 'post'; }).map(summary) };
        });
      }
    },
    {
      name: 'get_page',
      description: 'Returns the full content of any page on this website as structured sections, without opening it. ' +
        'Accepts the page title, part of the title, a slug or a path (for example "about" or "projects/this-site").',
      inputSchema: {
        type: 'object',
        properties: { page: { type: 'string', description: 'Page title, part of the title, slug or path.' } },
        required: ['page']
      },
      annotations: { readOnlyHint: true },
      execute: function (input) {
        return loadIndex().then(function (index) {
          if (!index) return { error: NO_INDEX, currentPage: pageContent(document, location.href) };
          var p = findPage(index.pages, input.page);
          if (!p) return { error: 'No page matches "' + input.page + '".', pages: index.pages.map(function (x) { return x.title; }) };
          return loadPage(p.url).then(function (doc) { return pageContent(doc, p.url); });
        });
      }
    },
    {
      name: 'list_posts',
      description: 'Lists the blog posts / articles on this website, newest first, each with title, one-line description, publish date and URL.',
      annotations: { readOnlyHint: true },
      execute: function () {
        return loadIndex().then(function (index) {
          if (!index) return { posts: page.kind === 'post' ? [summary(Object.assign({}, page, { url: pageUrl }))] : [], note: NO_INDEX };
          var all = posts(index);
          return { posts: all.map(summary), note: all.length ? undefined : 'Nothing published yet.' };
        });
      }
    },
    {
      name: 'get_post',
      description: 'Returns one blog post as structured data without opening it: thesis, takeaways, who it is for, ' +
        'each claim with its evidence type (measured, experienced, cited or opinion), limitations, sources, disclosures, dates and next steps. ' +
        'Accepts the post title, part of the title, or its slug. On a post\'s own page, the get_post_* tools answer narrower questions.',
      inputSchema: {
        type: 'object',
        properties: { post: { type: 'string', description: 'Post title, part of the title, or slug.' } },
        required: ['post']
      },
      annotations: { readOnlyHint: true },
      execute: function (input) {
        return loadIndex().then(function (index) {
          if (!index) return { error: NO_INDEX };
          var all = posts(index);
          var p = findPage(all, input.post);
          if (!p) return { error: 'No post matches "' + input.post + '".', posts: all.map(function (x) { return x.title; }) };
          return {
            title: p.title,
            url: p.url,
            description: p.description || null,
            author: p.author || null,
            published: p.published || null,
            updated: p.updated || null,
            outline: list(p.outline).map(function (s) { return { heading: s.heading, url: p.url + s.anchor }; }),
            agent: p.agent || null,
            note: p.agent ? undefined : 'This post has no agent: frontmatter; call get_page for its text.'
          };
        });
      }
    },
    {
      name: 'search_site',
      description: 'Searches every page and post on this website for a word or phrase and returns matching pages with a short excerpt around each match.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Word or phrase to search for (case-insensitive).' } },
        required: ['query']
      },
      annotations: { readOnlyHint: true },
      execute: function (input) {
        var query = clean(input.query).toLowerCase();
        if (!query) return { error: 'query must not be empty' };
        return loadIndex().then(function (index) {
          var candidates = index ? index.pages : [{ title: page.title, url: pageUrl, text: text(contentRoot(document)) }];
          var matches = candidates.map(function (p) {
            var body = p.text || '';
            var hay = (p.title + ' ' + (p.description || '') + ' ' + body).toLowerCase();
            if (hay.indexOf(query) === -1) return null;
            var idx = body.toLowerCase().indexOf(query);
            var excerpt = idx === -1 ? (p.description || '') :
              (idx > 80 ? '…' : '') + body.slice(Math.max(0, idx - 80), idx + query.length + 80) + '…';
            return { title: p.title, url: p.url, excerpt: excerpt };
          }).filter(Boolean);
          return { query: query, matches: matches, note: index ? undefined : NO_INDEX };
        });
      }
    }
  ];

  // set_theme: Quarto's own light/dark toggle, or the selectors in `webmcp.theme`.
  var theme = site.theme || {};
  var quartoToggle = typeof window.quartoToggleColorScheme === 'function' && document.querySelector('.quarto-color-scheme-toggle');
  if (quartoToggle || (theme.light && theme.dark)) {
    tools.push({
      name: 'set_theme',
      description: 'Switches this website between its light and dark color themes.',
      inputSchema: {
        type: 'object',
        properties: { theme: { type: 'string', enum: ['light', 'dark'] } },
        required: ['theme']
      },
      annotations: { readOnlyHint: false },
      execute: function (input) {
        if (theme.light && theme.dark) {
          var btn = document.querySelector(theme[input.theme]);
          if (!btn) return { error: 'No theme control matches ' + theme[input.theme] };
          btn.click();
          return { theme: input.theme };
        }
        var isDark = document.body.classList.contains('quarto-dark');
        if ((input.theme === 'dark') !== isDark) window.quartoToggleColorScheme();
        return { theme: document.body.classList.contains('quarto-dark') ? 'dark' : 'light' };
      }
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Post tools: only on a page with `agent:` frontmatter
  // ---------------------------------------------------------------------------------------------

  var SELF_REPORTED = 'Written by the post author. Check the linked evidence before relying on it.';

  if (page.agent) {
    tools.push(
      {
        name: 'get_post_summary',
        description: 'Summarizes the blog post open on this page. depth "one_line" returns the thesis only; "abstract" (default) adds the key takeaways; ' +
          '"outline" adds every section heading with a link. Use for "what is this post about?" or "what\'s the main point?".',
        inputSchema: {
          type: 'object',
          properties: { depth: { type: 'string', enum: ['one_line', 'abstract', 'outline'] } }
        },
        annotations: { readOnlyHint: true },
        execute: function (input) {
          var depth = input.depth || 'abstract';
          var out = { title: page.title, url: pageUrl, thesis: agent.summary || page.description || null };
          if (depth === 'one_line') return out;
          out.description = page.description || null;
          out.takeaways = list(agent.takeaways);
          if (depth === 'outline') {
            out.outline = list(page.outline).map(function (s) { return { heading: s.heading, url: pageLink(s.anchor) }; });
          }
          return out;
        }
      },
      {
        name: 'check_post_fit',
        description: 'Says who the blog post open on this page is for and not for, what it assumes the reader knows, and where its advice stops applying. ' +
          'Pass the reader\'s role, situation or goal to have them echoed next to the criteria; compare them yourself. ' +
          'Use for "is this relevant to me?" or "will this work for my situation?".',
        inputSchema: {
          type: 'object',
          properties: {
            role: { type: 'string', description: 'The reader\'s role, e.g. "platform engineer".' },
            situation: { type: 'string', description: 'The reader\'s context, e.g. "monorepo on self-hosted runners".' },
            goal: { type: 'string', description: 'What the reader wants to get done.' }
          }
        },
        annotations: { readOnlyHint: true },
        execute: function (input) {
          var aud = agent.audience || {};
          return {
            reader: { role: input.role || null, situation: input.situation || null, goal: input.goal || null },
            goodFitIf: list(aud['for']),
            notAFitIf: list(aud.not_for),
            prerequisites: list(aud.prerequisites),
            limitations: list(agent.limitations),
            howToDecide: 'The post fits if the reader matches goodFitIf, matches nothing in notAFitIf, and no limitation applies to their situation.'
          };
        }
      },
      {
        name: 'get_post_credibility',
        description: 'Answers "why should I trust this blog post?" for the post open on this page: who wrote it and their hands-on experience with this topic, ' +
          'when it was published and updated, the tool or library versions it was tested against, parts the author knows are outdated, ' +
          'and disclosures (sponsorships, affiliate links, products the author sells).',
        annotations: { readOnlyHint: true },
        execute: function () {
          var disclosures = list(agent.disclosures);
          return {
            author: {
              name: page.author || site.owner || null,
              experienceWithThisTopic: agent.author_experience || null,
              about: site.about ? absUrl(site.about) : null
            },
            published: page.published || null,
            updated: page.updated || page.published || null,
            testedAgainst: agent.tested_against || {},
            knownOutdated: list(agent.outdated),
            disclosures: disclosures.length ? disclosures : ['None. The author declares no sponsorship, affiliate links or related product.'],
            note: SELF_REPORTED
          };
        }
      },
      {
        name: 'get_post_claims',
        description: 'Lists the claims the blog post open on this page makes, each with its evidence: type (measured = the author measured it, ' +
          'experienced = from the author\'s own practice, cited = from a linked source, opinion = the author\'s judgment), details and a link. ' +
          'Pass claim_id for one claim. Use for "how do they know?" or "is the evidence any good?".',
        inputSchema: {
          type: 'object',
          properties: { claim_id: { type: 'string', description: 'One claim id from a previous call. Omit for all claims.' } }
        },
        annotations: { readOnlyHint: true },
        execute: function (input) {
          var all = list(agent.claims).map(function (c) {
            var e = c.evidence || {};
            return { id: c.id, claim: c.claim, evidence: { type: e.type, detail: e.detail || null, link: pageLink(e.link) } };
          });
          if (!input.claim_id) return { claims: all, note: SELF_REPORTED };
          var one = all.filter(function (c) { return c.id === input.claim_id; })[0];
          if (!one) return { error: 'No claim with id "' + input.claim_id + '".', claimIds: all.map(function (c) { return c.id; }) };
          return one;
        }
      },
      {
        name: 'get_post_context',
        description: 'Shows how the blog post open on this page relates to other work: sources it builds on, sources that support or contradict it, ' +
          'and the author\'s related posts. Use for "how does this fit with what else is out there?" or "what do others say?".',
        annotations: { readOnlyHint: true },
        execute: function () {
          var groups = { builds_on: [], supports: [], contradicts: [], background: [] };
          list(agent.sources).forEach(function (s) {
            var key = (s.relation || 'background').replace('-', '_');
            (groups[key] || groups.background).push({ title: s.title || s.url, url: pageLink(s.url), note: s.note || null });
          });
          var postsDir = (site.posts || 'posts').replace(/^\/|\/$/g, '');
          return {
            sources: groups,
            relatedPosts: list(agent.related).map(function (slug) { return { slug: slug, url: absUrl(postsDir + '/' + slug + '/') }; }),
            tip: 'Call get_post with a related post\'s slug to read it without leaving this page.'
          };
        }
      },
      {
        name: 'get_post_next_steps',
        description: 'Says what to do after reading the blog post open on this page: concrete next steps with links to templates, code or files, ' +
          'plus the limitations, so the reader knows when not to follow the advice. Use for "so what?" or "what should I do with this?".',
        annotations: { readOnlyHint: true },
        execute: function () {
          return {
            nextSteps: list(agent.next_steps).map(function (s) {
              return typeof s === 'string' ? { action: s, link: null } : { action: s.action, link: pageLink(s.link) };
            }),
            limitations: list(agent.limitations),
            contact: site.about ? 'For questions the post does not answer, see ' + absUrl(site.about) : null
          };
        }
      }
    );
  }

  window.siteTools = {
    __quartoWebmcp: true,
    webmcp: status,
    add: addTools,
    json: json,
    absUrl: absUrl,
    data: data,
    index: loadIndex,
    // Helpers for site-specific tools.
    loadPage: loadPage,
    text: text,
    sections: sections,
    pageContent: pageContent,
    findPage: findPage,
    list: function () {
      return wrapped.map(function (t) {
        return { name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations };
      });
    },
    call: function (name, input) {
      var tool = wrapped.filter(function (t) { return t.name === name; })[0];
      if (!tool) return Promise.resolve(json({ error: 'Unknown tool: ' + name, tools: wrapped.map(function (t) { return t.name; }) }));
      return tool.execute(input);
    }
  };

  addTools(tools);
  document.dispatchEvent(new CustomEvent('webmcp:ready', { detail: window.siteTools }));
}
