-- quarto-webmcp: exposes a Quarto site's content to in-browser AI agents through WebMCP.
--
-- For every HTML page, this filter:
--   1. Embeds the page's data (title, description, dates, outline, and the `agent:` frontmatter
--      of posts) plus the site's `webmcp:` settings as <script type="application/json" id="webmcp-data">.
--      Readers never see it. webmcp.js reads it to register tools, and webmcp-index.ts collects it
--      from every page into webmcp-index.json and llms.txt after the render.
--   2. Attaches webmcp.js, which registers the tools with document.modelContext when the browser
--      supports WebMCP and does nothing visible otherwise.
--   3. Adds any origin-trial tokens from `webmcp.origin-trials` to the page <head>.
--
-- Malformed `agent:` data fails the render instead of publishing tools that mislead agents.
-- Settings and the `agent:` schema are documented in README.md.

local VERSION = "0.1.0"

local EVIDENCE_TYPES = { measured = true, experienced = true, cited = true, opinion = true }
local SOURCE_RELATIONS = { supports = true, contradicts = true, ["builds-on"] = true, background = true }

local function str(v)
  if v == nil then return nil end
  local s = pandoc.utils.stringify(v)
  if s == "" then return nil end
  return s
end

-- Pandoc metadata (Inlines, Lists, maps) -> plain Lua values. Lists stay pandoc.List so the
-- encoder can tell arrays from objects, including empty ones.
local function plain(v)
  local t = pandoc.utils.type(v)
  if t == "Inlines" or t == "Blocks" or t == "Inline" or t == "Block" then
    return pandoc.utils.stringify(v)
  elseif t == "List" then
    local out = pandoc.List()
    for _, x in ipairs(v) do out:insert(plain(x)) end
    return out
  elseif type(v) == "table" then
    local out = {}
    for k, x in pairs(v) do out[k] = plain(x) end
    return out
  end
  return v
end

-- Escapes <, > and & as well, so the JSON can never close its <script> element.
local function quote(s)
  return '"' .. s:gsub('[%c"\\<>&]', function(c) return string.format("\\u%04x", c:byte()) end) .. '"'
end

local function encode(v)
  if v == nil then return "null" end
  if pandoc.utils.type(v) == "List" then
    local parts = {}
    for _, x in ipairs(v) do parts[#parts + 1] = encode(x) end
    return "[" .. table.concat(parts, ",") .. "]"
  end
  if type(v) == "table" then
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = tostring(k) end
    table.sort(keys)
    local parts = {}
    for _, k in ipairs(keys) do parts[#parts + 1] = quote(k) .. ":" .. encode(v[k]) end
    return "{" .. table.concat(parts, ",") .. "}"
  end
  if type(v) == "boolean" or type(v) == "number" then return tostring(v) end
  return quote(tostring(v))
end

local function list(v)
  if pandoc.utils.type(v) == "List" then return v end
  return pandoc.List()
end

local function is_map(v)
  return type(v) == "table" and pandoc.utils.type(v) ~= "List"
end

local function validate(agent, file)
  local seen = {}
  for i, c in ipairs(list(agent.claims)) do
    local where = file .. ": agent.claims[" .. i .. "]"
    if not (is_map(c) and c.id and c.claim) then error(where .. " needs `id` and `claim`") end
    if seen[c.id] then error(where .. ": duplicate claim id `" .. c.id .. "`") end
    seen[c.id] = true
    if not is_map(c.evidence) then error(where .. " needs `evidence`") end
    if not EVIDENCE_TYPES[c.evidence.type] then
      error(where .. ".evidence.type must be measured, experienced, cited or opinion")
    end
  end
  for i, s in ipairs(list(agent.sources)) do
    local where = file .. ": agent.sources[" .. i .. "]"
    if not (is_map(s) and s.url) then error(where .. " needs `url`") end
    if s.relation ~= nil and not SOURCE_RELATIONS[s.relation] then
      error(where .. ".relation must be supports, contradicts, builds-on or background")
    end
  end
end

-- Path from this page to the project root ("." or "..", "../.." ...), so the browser can find
-- webmcp-index.json from any page, including sites served from a subfolder.
local function project_offset()
  local ok, offset = pcall(function() return quarto.project.offset end)
  if ok and type(offset) == "string" and offset ~= "" then return offset end
  return "."
end

-- "posts/my-post/index.qmd" under the posts folder counts as a post; "posts/index.qmd" (the listing) does not.
local function is_post(file, posts_dir)
  local norm = file:gsub("\\", "/")
  local rest = norm:match("/" .. posts_dir:gsub("%p", "%%%0") .. "/(.+)$")
  return rest ~= nil and rest ~= "index.qmd" and rest ~= "index.md" and rest ~= "index.ipynb"
end

local function site_settings(meta, cfg)
  local website = is_map(meta.website) and plain(meta.website) or {}
  return {
    name = cfg.name or website.title or str(meta.pagetitle),
    description = cfg.description or website.description,
    owner = cfg.owner,
    url = cfg["site-url"] or website["site-url"],
    source = cfg.source or website["repo-url"],
    about = cfg.about,
    links = is_map(cfg.links) and cfg.links or nil,
    posts = cfg.posts or "posts",
    theme = is_map(cfg.theme) and cfg.theme or nil,
    index = cfg.index ~= false,
    version = VERSION,
  }
end

function Pandoc(doc)
  if not quarto.doc.is_format("html") then return nil end

  local meta = doc.meta
  local cfg = is_map(meta.webmcp) and plain(meta.webmcp) or {}
  if cfg.enabled == false then return nil end

  local file = quarto.doc.input_file or ""
  local site = site_settings(meta, cfg)

  local agent = nil
  if meta.agent ~= nil then
    agent = plain(meta.agent)
    if not is_map(agent) then error(file .. ": `agent` must be a map") end
    validate(agent, file)
  end

  local outline = pandoc.List()
  doc.blocks:walk({
    Header = function(h)
      if h.level == 2 and h.identifier ~= "" then
        outline:insert({ heading = pandoc.utils.stringify(h.content), anchor = "#" .. h.identifier })
      end
    end,
  })

  local page = {
    title = str(meta.title) or str(meta.pagetitle),
    description = str(meta.description) or str(meta.subtitle),
    author = str(meta.author),
    published = str(meta.date),
    updated = str(meta["date-modified"]),
    kind = (agent ~= nil or is_post(file, site.posts)) and "post" or "page",
    draft = meta.draft == true,
    outline = outline,
    agent = agent,
  }

  local data = { site = site, page = page, root = project_offset() }
  doc.blocks:insert(pandoc.RawBlock("html",
    '<script type="application/json" id="webmcp-data">' .. encode(data) .. "</script>"))

  quarto.doc.add_html_dependency({
    name = "webmcp",
    version = VERSION,
    scripts = { { path = "webmcp.js", afterBody = true } },
  })

  local tokens = list(cfg["origin-trials"])
  if #tokens > 0 then
    local tags = {}
    for _, t in ipairs(tokens) do
      tags[#tags + 1] = '<meta http-equiv="origin-trial" content="' .. tostring(t):gsub('"', "&quot;") .. '">'
    end
    quarto.doc.include_text("in-header", table.concat(tags, "\n"))
  end

  return doc
end
