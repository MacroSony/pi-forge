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

Published pi-forge treats Pi-owned SDK packages (`pi-agent-core`, `pi-ai`, `pi-coding-agent`, `pi-tui`, and `typebox`) as host-provided wildcard peers. The running Pi host supplies one coherent SDK instance, avoiding duplicate packages and avoiding an install-time lock to Pi's frequent release cadence.

The repository keeps exact SDK versions as development/test fixtures for reproducibility. Exact fixtures do not constrain which Pi version may load the published extension.

Release validation should test:

- the documented minimum supported Pi version;
- the current Pi version at release time;
- an automated or scheduled probe of npm `latest`.

Document the tested range separately from peer constraints. Pi-coupled experimental subagent capabilities must preflight against the actual host and fail closed with a precise compatibility diagnostic when required APIs are unavailable; ordinary stacks and profiles should remain usable.

## Package boundaries

- `@zihanw/pi-forge` is the Pi extension and stable macro/slot registration surface.
- `@zihanw/pi-forge/subagent` is the preferred experimental host-contract entry point.
- `@zihanw/pi-subagent-runtime` owns execution lifecycle and fresh-process backends.
- Legacy `@zihanw/pi-forge/src/*` aliases resolve to compiled compatibility modules and are not a promise that internals are public.

See the [public API policy](../reference/public-api.md).
