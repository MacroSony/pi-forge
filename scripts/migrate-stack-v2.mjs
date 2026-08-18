#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const RUNTIME_ALIASES = new Map([
  ["lastUserMessage", "runtime.lastUserMessage"],
  ["date", "runtime.date"],
  ["time", "runtime.time"],
  ["cwd", "runtime.cwd"],
  ["tools", "runtime.selectedToolsText"],
  ["selectedTools", "runtime.selectedToolsText"],
  ["activeModel", "runtime.activeModel"],
]);

const KNOWN_FILTERS = new Set(["trim", "upper", "lower", "json", "xml"]);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const ROOT_PATH = /^(parameters|runtime|extensions)\.[A-Za-z_][A-Za-z0-9_.-]*$/;

const HELP = `pi-forge stack v1 -> v2 migration

Usage:
  node scripts/migrate-stack-v2.mjs <file.json> [--write]

Converts mechanical v1 constructs to forge-v1 / schema v2:
  - variables -> parameters
  - known static {{name}} -> {{ parameters.name }}
  - runtime bare macros -> {{ runtime.* }}
  - simple {{filter::value}} pipelines -> {{ value | filter }}

Anything non-mechanical is reported; --write is refused while those remain.
`;

const args = process.argv.slice(2);
const file = args.find((arg) => arg && !arg.startsWith("--"));
const write = args.includes("--write");

if (!file) {
  console.log(HELP);
  process.exit(1);
}
if (!existsSync(file)) {
  console.error(`File not found: ${file}`);
  process.exit(1);
}

const raw = JSON.parse(readFileSync(file, "utf8"));
const diagnostics = [];

if (raw.schemaVersion === 2) {
  if (raw.variables !== undefined) {
    console.warn("Warning: schemaVersion 2 stack still has a variables field; it is ignored. Migrate it to parameters.");
  } else {
    console.log("Already schemaVersion 2; nothing to do.");
  }
  process.exit(0);
}

const staticNames = new Set(Object.keys(raw.variables ?? {}));

// Static parameters win over runtime aliases, matching forge-v1's
// parameters-first single-segment resolution.
function mapPath(value) {
  const trimmed = (value ?? "").trim();
  if (staticNames.has(trimmed)) return `parameters.${trimmed}`;
  if (RUNTIME_ALIASES.has(trimmed)) return RUNTIME_ALIASES.get(trimmed);
  if (ROOT_PATH.test(trimmed)) return trimmed;
  if (IDENTIFIER.test(trimmed)) {
    diagnostics.push(`non-mechanical: ${trimmed} (unknown custom macro or missing static parameter)`);
    return null;
  }
  diagnostics.push(`non-mechanical: ${trimmed}`);
  return null;
}

function convertText(text) {
  let out = "";
  let index = 0;
  while (index < text.length) {
    let openIdx = -1;
    let delimiter = null;
    for (const marker of ["{{", "{%"]) {
      const i = text.indexOf(marker, index);
      if (i !== -1 && (openIdx === -1 || i < openIdx)) {
        openIdx = i;
        delimiter = marker;
      }
    }
    if (openIdx === -1) {
      out += text.slice(index);
      break;
    }
    out += text.slice(index, openIdx);
    const close = delimiter === "{{" ? "}}" : "%}";
    const end = text.indexOf(close, openIdx);
    if (end === -1) {
      diagnostics.push(`non-mechanical: unclosed ${delimiter} token`);
      out += text.slice(openIdx);
      break;
    }
    const inner = text.slice(openIdx + 2, end).trim();
    const token = text.slice(openIdx, end + 2);
    if (delimiter === "{{") {
      out += convertOutput(inner, token);
    } else {
      out += convertBlock(inner, token);
    }
    index = end + 2;
  }
  return out;
}

function convertOutput(inner, originalToken) {
  if (ROOT_PATH.test(inner)) return `{{ ${inner} }}`;

  // Pipeline: map the leading path, keep filters.
  if (inner.includes("|")) {
    const parts = inner.split("|").map((p) => p.trim());
    const head = parts.shift();
    const mapped = head === undefined ? null : mapPath(head);
    if (mapped !== null && parts.every((f) => KNOWN_FILTERS.has(f))) {
      return `{{ ${mapped}${parts.map((f) => ` | ${f}`).join("")} }}`;
    }
    diagnostics.push(`non-mechanical: {{${inner}}}`);
    return originalToken;
  }

  const filterMatch = inner.match(/^(trim|upper|lower|json|xml)::(.+)$/);
  if (filterMatch) {
    const [, filter, value] = filterMatch;
    const mapped = mapPath(value);
    if (mapped !== null) return `{{ ${mapped} | ${filter} }}`;
    return originalToken;
  }

  const mapped = mapPath(inner);
  if (mapped !== null) return `{{ ${mapped} }}`;
  return originalToken;
}

function convertBlock(inner, originalToken) {
  if (inner.startsWith("if ")) {
    const predicate = inner.slice(3).trim();
    if (!/^[\w.-]+(\s*(==|!=)\s*"([^"]*)"\s*)?$/.test(predicate)) {
      diagnostics.push(`non-mechanical: {% ${inner} %}`);
      return originalToken;
    }
    return `{% ${inner} %}`;
  }
  if (inner === "else" || inner === "endif") return `{% ${inner} %}`;
  diagnostics.push(`non-mechanical: {% ${inner} %}`);
  return originalToken;
}

const result = { ...raw, schemaVersion: 2 };
result.parameters = raw.variables ?? {};
delete result.variables;

if (Array.isArray(result.items)) {
  for (const item of result.items) {
    if (item && typeof item.content === "string") {
      item.content = convertText(item.content);
    }
  }
}

const hasNonMechanical = diagnostics.some((d) => d.startsWith("non-mechanical"));
console.log(`Migrated ${file} to schemaVersion 2.`);
console.log("Diagnostics:");
for (const d of diagnostics) console.log(`  - ${d}`);

if (hasNonMechanical) {
  console.error("Non-mechanical constructs remain; refusing to write. Fix them manually.");
  process.exit(1);
}
if (write) {
  writeFileSync(file, JSON.stringify(result, null, 2) + "\n", "utf8");
  console.log("Wrote migrated stack.");
} else {
  console.log("Dry run; pass --write to save.");
}
