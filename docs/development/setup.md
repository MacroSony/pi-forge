# Development setup

[Documentation](../README.md)

## Build from source

```bash
git clone https://github.com/MacroSony/pi-forge.git
cd pi-forge
npm install
npm run build
pi
```

Trust the project in Pi and use `/reload` when needed.

Before making structural changes, read the [architecture and development rules](architecture-rules.md) and the active [0.5 architecture plan](../design/architecture-0.5.md). Boundary, schema, persistence, public API, and product changes require an accepted architecture decision before implementation.

The npm package loads compiled `dist/index.js` and intentionally omits physical `src/` files. Clone or fork the repository to inspect or modify source; do not edit generated files in `node_modules`.

## Load the extension

For release-like local testing, register the cloned package directory in Pi settings:

```json
{
  "packages": ["../pi-forge"]
}
```

For live source development, remove that package entry and load the TypeScript extension directly:

```json
{
  "extensions": ["../pi-forge/src/index.ts"]
}
```

You can also run `pi -e ../pi-forge/src/index.ts` for a one-off smoke test. Never load both package and source entries simultaneously; pi-forge would initialize twice.

Browser-client source changes require `npm run build:client` because the editor serves a generated embedded bundle.

## Verification

```bash
npm test                 # core Node test suite
npm run test:browser     # real-browser editor characterization
npm run typecheck        # TypeScript and Vue
npm run build            # client bundle and dist output
npm run verify           # all tests plus generated/package consistency
npm pack --dry-run       # inspect the publishable tarball
```

Set `CHROME_PATH` when Chrome/Chromium is outside a standard location. CI runs the full verification. When source changes generated output, commit matching generated client and `dist` files.

## Pi compatibility

Pi-forge treats Pi-owned SDK packages (`pi-agent-core`, `pi-ai`, `pi-coding-agent`, `pi-tui`, and `typebox`) as host-provided optional peers, not private runtime dependencies. Published Forge 0.5.7 declared peer range `>=0.87.0 <0.88.0`. Forge 0.5.11 expands supported peers to the union:
```
>=0.87.0 <0.88.0 || 0.99.0 || 0.99.1 || 0.99.2 || >=1.0.0 <1.6.0
```
The repository dev SDK fixtures are updated to `1.5.0` with `typebox@1.3.27`. The minimum supported version remains `0.87.0`; there is no claim of dual 0.86 runtime support. The running host supplies one coherent SDK instance, avoiding duplicate packages and exact-version locks while expressing the actual API requirement. See the [Pi 1.0 compatibility guide](../guides/pi-1-compatibility.md).

The repository keeps exact SDK versions as development/test fixtures for reproducibility. Exact fixtures do not constrain which Pi version may load the published extension.

Release validation and smoke testing verify:

- the documented minimum supported Pi version (`0.87.0`);
- the current Pi version at release time (`1.5.0`), with earlier releases (`1.0.0`, `1.0.1`, `1.0.2`, `1.0.4`, `1.1.0`, `1.2.0`, `1.3.0`, `1.4.0`) as compatibility lanes;
- an automated or scheduled probe of npm `latest`.

Run packed installation tests against specific target versions using environment variables:

```bash
# Verify packed install against pinned minimum (0.87.0):
PI_TEST_VERSION=0.87.0 TYPEBOX_TEST_VERSION=1.3.7 npm run check:packed

# Verify packed install against current Pi 1.5.0:
PI_TEST_VERSION=1.5.0 TYPEBOX_TEST_VERSION=1.3.27 npm run check:packed
```

Ordinary Linux/macOS/Windows CI uses Pi 1.5.0; older supported versions, including minimum 0.87.0 and Pi 1.0.0/1.0.1/1.0.2/1.0.4/1.1.0/1.2.0/1.3.0/1.4.0, are explicit Linux compatibility lanes; passing CI on the exact release commit is a release gate (its result is not recorded in this document).

Document the tested range separately from peer constraints. Pi-coupled experimental subagent capabilities must preflight against the actual host and fail closed with a precise compatibility diagnostic when required APIs are unavailable; ordinary stacks and profiles should remain usable.

## Package boundaries

- `@zihanw/pi-forge` is the Pi extension (default export) and the stable macro/slot registration surface; no other root exports or `src/*` aliases exist.
- `@zihanw/pi-forge/subagent` is the experimental versioned host-port entry point (wire DTOs, validators, transport, client/host lifecycle, canonical fingerprints).
- `@zihanw/pi-forge-subagents` is the optional package owning subagent execution, configuration, and the 0.4 execution contract.
- `@zihanw/pi-subagent-runtime` owns execution lifecycle and fresh-process backends (a dependency of the optional package, not of the main package).

See the [public API policy](../reference/public-api.md).

### Coherent fixtures versus fresh consumers

Compatibility CI pins the four SDKs and, for 1.x, codemode/MCP/telemetry/chord to the same exact version and asserts resolved versions. These are explicit coherent fixtures, not ordinary fresh consumer resolution. By default the packed check keeps normal npm resolution and verifies the installed four-SDK family; the ordinary 1.5.0 jobs (all three platforms) are the unconstrained normal-consumer gate. Compatibility lanes set `PI_TEST_COHERENT_UPSTREAM=1`, which also pins codemode/MCP/telemetry/chord to the host version inside the packed consumers and is printed in the log. This is required because fresh unconstrained installs of Pi 1.0.1–1.1.x now resolve their caret ranges to newer, incompatible upstream releases (observed 2026-10-20: Pi 1.1.0 + pi-codemode 1.3.0 fails with a missing `MCP_TYPESCRIPT_PREAMBLE` export) independently of Forge. Fixture success on those lanes says Forge works on that host family; it does not claim that a fresh unconstrained install of that old Pi works.

Pi 1.3 pins its internal Pi dependencies exactly; normal 1.3 consumers resolve the four SDKs plus codemode/MCP/telemetry to 1.3.0 without a fixture overlay. Real-SDK regressions cover default/modifier transcript tool restoration, resumed Preset initial/allow/deny policy, Capability additions, and disabling a Preset back to the policy owner's saved startup baseline (with distinguishable external changes reconciled). Those 0.5.9 restoration changes did not change execution authorization or enable every default-active extension tool on resume. Forge 0.5.10 separately adds [effective-set execution authorization](../reference/capabilities.md#execution-authorization-forge-0510).
