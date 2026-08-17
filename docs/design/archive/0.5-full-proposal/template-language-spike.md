# Template-language and compiler spike

[Design index](README.md) · [0.5 architecture plan](architecture-0.5.md) · [0.5 migration inventory](0.5-inventory.md)

Status: completed Phase 0 spike; architecture decision pending

Date: 2026-08-17

## Question

Which template language can replace 0.4 macros while keeping prompt compilation
deterministic over immutable inputs, statically analyzable, migrationable, and
free of arbitrary evaluation or template loading?

## Characterized 0.4 surface

The current macro language mixes four separate concerns:

| Concern | 0.4 behavior | 0.5 direction |
|---|---|---|
| Immutable runtime values | Latest user message, date/time, cwd, selected tools, active model | Keep as explicit values in `PromptEnvironment` |
| Static reusable values | `stack.variables`, referenced as `{{name}}` | Keep as JSON-compatible immutable `parameters` |
| Text transforms | `trim`, `upper`, `lower`, `json`, `xml`, including nesting | Retain only as a finite, pure filter set if accepted |
| Control flow | `ifvar`, `ifeq`, `iftools`, `ifslot`, with lazy branches | Replace only with a parsed, side-effect-free conditional form if accepted |
| Mutable state | Turn/session variables plus set/get/clear macros and `variables` slot | Remove; emit migration diagnostics |
| Executable extension code | Trusted custom macro and slot renderers receive live runtime objects | Replace only through a separately accepted, immutable template/slot port |

The current examples demonstrate simple parameter and runtime interpolation;
the image-reader and SillyTavern examples also depend on nested filters,
conditionals, and mutable variables. SillyTavern is already removed from 0.5
scope. Any remaining non-mechanical construct must be diagnosed by migration,
not silently approximated.

## Requirements

The v2 engine must provide one `parse → analyze → render` contract and meet all
of the following:

- parsing has no filesystem, network, process, clock, environment, or Pi access;
- rendering receives only a frozen normalized environment and parsed template;
- undefined paths, invalid filters, invalid conditions, parse errors, recursion,
  and output-limit breaches are typed errors, never silent mutation or ambient
  fallback;
- analysis returns source-spanned dependencies on environment paths, filters,
  control predicates, and registered template/slot capabilities;
- no includes, extends, imports, macros, function calls, loops, arbitrary
  property traversal, or general expression evaluation;
- whitespace is preserved unless a deliberately documented syntax construct
  changes it; rendering has a bounded output size;
- preview, parent runtime, and subagent preparation invoke the same engine and
  receive recorded environment/provenance values.

## Candidate comparison

| Candidate | Parse/analyze/render fit | Restriction and determinism | Migration fit | Result |
|---|---|---|---|---|
| General Jinja-like engine (Nunjucks) | Has parsing/rendering and strict-undefined option | Fails the trust requirement: its own documentation says it does not sandbox user-defined templates; it supports loaders, includes, extensions, async behavior, and a rich expression language | Familiar delimiters, but an unsafe/surplus language would need a fragile denylist | Reject |
| Restricted LiquidJS wrapper | Provides parsed templates and documented static analysis | Better parser option, but its Liquid tags, includes, filters, and plugin model would still require a security-sensitive allowlist/wrapper; syntax is not Jinja-compatible | Requires a new Liquid migration plus wrapper-specific dependency semantics | Do not adopt for 0.5 |
| Small Forge AST grammar | Contract is designed exactly for parse/analyze/render and the allowed syntax is closed | No ambient capabilities or loaders by construction; all values and filters are explicit | Breaking but small, predictable, and mechanically migrates common interpolation | Recommended candidate |

Nunjucks documents both its lack of sandboxing and its extensible loaders,
includes, custom tags, and asynchronous behavior. [Nunjucks API](https://mozilla.github.io/nunjucks/api.html)
LiquidJS documents parsed-template reuse and static analysis, but is a broader
Liquid language with tags and plugins rather than the deliberately closed v2
language. [LiquidJS static analysis](https://liquidjs.com/tutorials/static-analysis.html)

## Recommended decision candidate: `forge-v1`

Adopt a small parsed Forge template grammar. It resembles Jinja only at the
delimiter level; it must not claim Jinja compatibility.

### Closed grammar

```text
text        := any text outside delimiters
output      := "{{" path filters? "}}"
filters     := ("|" filterName)*
if-block    := "{% if" predicate "%}" template
               ("{% else %}" template)? "{% endif %}"
path        := identifier ("." identifier)*
predicate   := path | path "==" json-string | path "!=" json-string
```

The only initially proposed paths are `parameters.*` and documented
`runtime.*` fields. No bracket access, method invocation, object construction,
numeric arithmetic, loops, user-defined functions, imports, includes, extends,
macro definitions, or arbitrary expressions are in the grammar.

The initially proposed filters are `trim`, `upper`, `lower`, `json`, and `xml`.
They are pure, unary, versioned built-ins; unknown filters are errors. Tool and
slot conditions, if retained, must be represented as documented boolean values
in the environment rather than callable helpers. The exact v2 environment field
names remain part of the architecture decision.

### Engine contract

```ts
interface TemplateEngine {
  readonly id: "forge-v1";
  readonly version: 1;
  parse(source: string): TemplateParseResult;
  analyze(ast: TemplateAst): readonly TemplateDependency[];
  render(ast: TemplateAst, environment: PromptEnvironment): TemplateRenderResult;
}
```

`PromptEnvironment` is a frozen, JSON-compatible snapshot. It must carry an
explicit timestamp and timezone/formatting policy, cwd, model identity, selected
tool facts, latest-user-message data, static parameters, and the Pi-derived
inputs required by slots as separate structured values. The compiler—not the
engine—owns history placement, structured slots, tool/skill policy, base-system
prompt handling, message assembly, and regex stages.

The render receipt must identify engine ID/version, template dependencies,
environment/provenance fingerprint, diagnostics, and output size. Dependencies
are authoritative for preview and subagent preparation; no consumer may
re-parse syntax independently.

### Extension boundary implication

The current `registerMacro()` API cannot cross this boundary unchanged because
it receives live runtime objects and can mutate or observe ambient state. The
template decision does not yet authorize a replacement API. If custom template
values, filters, or slots remain in 0.5, a separate accepted port must give them
only frozen input, declared dependency/capability metadata, bounded output, and
a pure-rendering contract. Trusted extension code is not a security boundary;
the core engine nevertheless must remain deterministic when no such extension
port participates.

## Migration disposition

| 0.4 construct | Candidate v2 migration | Result when not mechanical |
|---|---|---|
| `{{name}}` for a known static value | `{{ parameters.name }}` | Warn when name could be a custom macro or ambiguous |
| `{{lastUserMessage}}`, date/time, cwd, model, selected tools | Corresponding documented `runtime.*` path | Mechanical only after field names are accepted |
| Nested value filters | Equivalent output plus pipeline where semantics match | Diagnose when nested arguments or behavior differ |
| `ifvar` / `ifeq` | Parsed `if` predicate where semantics match | Diagnose `iftools`/`ifslot` until boolean environment fields are accepted |
| Custom macros and slots | New port only after its decision | Diagnose; no compatibility execution shim |
| Set/get/clear variable macros and `variables` slot | None | Error-level migration diagnostic; removed behavior |
| Unknown macros / unresolved-policy behavior | None | Error-level diagnostic in v2; no keep/warn rendering policy |

The migration tool must preserve the original source, produce a field/item-level
report, and refuse a partly transformed file unless the user explicitly accepts
diagnostics. It must not rewrite SillyTavern inputs in 0.5.

## Required acceptance and implementation evidence

Before Phase 3 implementation, accept the grammar, exact environment schema,
filter/condition set, undefined/error semantics, output limits, engine ID in
stack schema v2, extension-port disposition, and migration behavior.

Implementation then needs characterization and conformance coverage for parser
errors, source spans, strict undefined values, filters, nested/else conditionals,
whitespace, output limits, deterministic repeated render, dependency receipts,
preview/runtime identity, and migration diagnostics for every removed mutable or
custom-macro construct.
