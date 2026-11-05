// Checks the Quarto Wizard files in _extensions/webmcp/:
//   - _schema.yml is valid against the published Quarto Wizard meta-schema it names in $schema;
//   - _snippets.json is well formed, and each snippet expands to YAML the schema accepts;
//   - the extensions.webmcp settings in the example site and example.qmd match the schema,
//     so the schema describes what people actually write.
// Usage: node tests/wizard.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import YAML from "yaml";

const ext = new URL("../_extensions/webmcp/", import.meta.url);
const root = new URL("../", import.meta.url);
const schema = YAML.parse(fs.readFileSync(new URL("_schema.yml", ext), "utf8"));

// 1. The schema file itself.
const meta = await (await fetch(schema.$schema)).json();
const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
const validMeta = ajv.compile(meta);
assert.ok(validMeta(schema), "_schema.yml: " + ajv.errorsText(validMeta.errors, { separator: "\n" }));

// A checker for the subset of the vocabulary _schema.yml uses, applied to real settings below.
const typeOf = (v) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);
function check(value, d, where, errors) {
  const types = d.type ? [].concat(d.type) : null;
  if (types && !types.includes(typeOf(value))) return errors.push(`${where}: expected ${types.join(" or ")}, got ${typeOf(value)}`);
  if (d.enum && !d.enum.includes(value)) errors.push(`${where}: ${JSON.stringify(value)} is not one of ${d.enum.join(", ")}`);
  if (typeOf(value) === "array" && d.items) value.forEach((x, i) => check(x, d.items, `${where}[${i}]`, errors));
  if (typeOf(value) === "object") {
    const props = d.properties || {};
    for (const [k, sub] of Object.entries(props)) {
      if (sub.required && !(k in value)) errors.push(`${where}.${k}: required`);
    }
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) check(v, props[k], `${where}.${k}`, errors);
      else if (d.additionalProperties === false) errors.push(`${where}.${k}: not in the schema`);
      else if (typeof d.additionalProperties === "object") check(v, d.additionalProperties, `${where}.${k}`, errors);
    }
  }
  return errors;
}
const checkSettings = (settings, where) => {
  const errors = check(settings, { type: "object", properties: schema.options, additionalProperties: false }, where, []);
  assert.deepEqual(errors, [], errors.join("\n"));
};

// Sanity check of the checker: it must reject what webmcp.lua rejects.
assert.ok(check({ claims: [{ id: "c1", claim: "x", evidence: { type: "guess" } }] }, schema.options.agent, "agent", []).length);
assert.ok(check({ sources: [{ title: "no url" }] }, schema.options.agent, "agent", []).length);

// 2. Snippets.
const snippets = JSON.parse(fs.readFileSync(new URL("_snippets.json", ext), "utf8"));
assert.ok(Object.keys(snippets).length > 0);
const prefixes = new Set();
for (const [name, s] of Object.entries(snippets)) {
  assert.equal(typeof s.prefix, "string", `${name}: prefix`);
  assert.ok(!prefixes.has(s.prefix), `${name}: duplicate prefix ${s.prefix}`);
  prefixes.add(s.prefix);
  assert.equal(typeof s.description, "string", `${name}: description`);
  assert.ok(Array.isArray(s.body) && s.body.length, `${name}: body`);
  // Expand placeholders to their defaults: ${1:text} -> text, ${1|a,b|} -> a, $0 -> "".
  const text = s.body.join("\n")
    .replace(/\$\{\d+:([^}]*)\}/g, "$1")
    .replace(/\$\{\d+\|([^,|]*)[^}]*\|\}/g, "$1")
    .replace(/\$\d+/g, "");
  const parsed = YAML.parse(text);
  if (parsed && parsed.extensions) checkSettings(parsed.extensions.webmcp, `snippet "${name}"`);
  else if (name === "Agent claim") check(parsed[0], schema.options.agent.properties.claims.items, name, []).forEach(assert.fail);
  else if (name === "Agent source") check(parsed[0], schema.options.agent.properties.sources.items, name, []).forEach(assert.fail);
  else assert.fail(`${name}: no check for this snippet`);
}

// 3. Settings people actually write.
const frontMatter = (file) => YAML.parse(fs.readFileSync(new URL(file, root), "utf8").split(/^---$/m)[1]);
const quartoYml = YAML.parse(fs.readFileSync(new URL("_quarto.yml", root), "utf8"));
checkSettings(quartoYml.extensions.webmcp, "_quarto.yml");
for (const file of ["example.qmd", "posts/agent-readable-posts/index.qmd"]) {
  const fm = frontMatter(file);
  assert.ok(fm.extensions?.webmcp?.agent, `${file}: extensions.webmcp.agent`);
  checkSettings(fm.extensions.webmcp, file);
}

console.log(`ok: _schema.yml (${Object.keys(schema.options).length} options) and ${prefixes.size} snippets`);
