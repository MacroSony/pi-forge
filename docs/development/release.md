# Release process

[Documentation](../README.md)

## Independent packages

The main `@zihanw/pi-forge` package has **no** dependency on `@zihanw/pi-forge-subagents` or `@zihanw/pi-subagent-runtime`. It can release independently; unfinished optional features do not block ordinary Forge use or a main-package release.

The optional package is tested against the released Forge host before its own publication. Any required runtime version must be published and smoke-tested before publishing the optional package that depends on it. Backend, continuation, background-task, and nested-usage producer acceptance belong to that companion release, not to the main package.

## Before main-package release

1. Confirm the intended version in the manifest, lockfile, changelog, and current user documentation. Preserve historical release records and document breaking configuration/session boundaries.
2. Install dependencies from the lockfile with `npm ci`, build, and run the complete `npm run verify` chain: Node tests, browser tests, types, generated client, docs, distribution, package contents, and packed installation.
3. Require the Ubuntu, macOS, Windows, and configured Pi compatibility GitHub Actions jobs to pass for the **exact release commit**, not an earlier source revision.
4. Test a packed main-package installation against both the documented minimum (0.87.0) and current tested Pi versions (1.0.2) using `PI_TEST_VERSION` / `TYPEBOX_TEST_VERSION`; exercise ordinary Preset/Profile/Capability behavior independently of optional delegation.
5. Inspect `npm pack --dry-run` for package size and unexpected or missing files. Publish the verified artifact, not an unreviewed working tree.

The macOS and Windows jobs run the same complete verification surface as Linux, including the real-browser editor suite. Compatibility-version (older supported releases) and scheduled latest-Pi probes remain Linux-only; they test dependency drift rather than operating-system behavior. Exact-release CI is a mandatory pre-release gate; this patch documentation does not claim cross-platform release CI has already passed.

## Dependency policy

The four Pi SDK packages remain host-provided optional peers, never private runtime dependencies. Published Forge 0.5.7 required Pi `>=0.87.0 <0.88.0`. Forge 0.5.8 expands supported peers to the union:
```
>=0.87.0 <0.88.0 || 0.99.0 || 0.99.1 || 0.99.2 || >=1.0.0 <1.1.0
```
Development fixtures are pinned to `1.0.2` with `typebox@1.3.27`. Minimum supported Pi `0.87.0` remains unchanged; The 1.0 range covers patch releases; Pi 0.86, other 0.x versions and Pi 1.1 or later are not implicitly supported. Exact tested versions belong in development dependencies and the lockfile, not exact host-version requirements. See the [Pi 1.0 compatibility guide](../guides/pi-1-compatibility.md).

To run packed installation smoke tests against the minimum or current version:

```bash
# Test packed install against pinned minimum (0.87.0):
PI_TEST_VERSION=0.87.0 TYPEBOX_TEST_VERSION=1.3.7 npm run check:packed

# Test packed install against current Pi 1.0.2:
PI_TEST_VERSION=1.0.2 TYPEBOX_TEST_VERSION=1.3.27 npm run check:packed
```

Published `@zihanw/pi-forge-subagents` 0.5.3 does not understand `tools.initial`. Its published dependency metadata does not include this source compatibility patch. A companion release can combine its pending features with Pi 1.0 adaptation, independently after the runtime floor is updated and the bubblewrap (`bwrap`) `/tmp` mount shadowing issue is resolved. This is an independent companion release, not a requirement to publish the packages simultaneously. See the [host-port compatibility note](../reference/subagent-host-port.md#tool-selection-compatibility).

## Package contents

The tarball must include compiled JavaScript, type declarations and source maps from `dist/`, JSON and TypeScript examples, the English and Chinese landing pages, changelog, license, and Markdown documentation. README images and demonstration media are repository-only: keep them in GitHub, use commit-pinned raw GitHub URLs in both READMEs, and do not package `assets/` or image/audio/video files anywhere in the tarball. Installed README text works offline; remote media requires network access. Positive `files` patterns exclude non-code/non-text additions by default. It must not include physical `src/` files. The root, `/subagent`, `/ui-contribution`, and `/command-contribution` entries must resolve to compiled output.

`prepack` runs the build and `check:package`; the latter uses `npm pack --dry-run --ignore-scripts` to inspect the actual inventory without recursive lifecycle calls. Media/asset entries and compressed tarballs above **2 MiB** fail the check. Keep the real-pack injection regression enabled. Any future essential runtime asset or budget change needs an explicit packaging review; do not simply widen the whitelist or remove the checks. These are normal build/release gates, not protection against deliberately bypassing lifecycle scripts.

The root `PUBLIC_API.md` and `SUBAGENT_ADAPTER_CONTRACT.md` files are compatibility pointers; authoritative content lives under `docs/reference/`.

## Publish and verify

With release authorization, publish the intended version using the intended tag (`latest` for a stable main-package release). Verify registry version, tag, and tarball integrity, then install the published package through Pi in a clean project and smoke-test the main commands and resource workflow without model inference.

Do not silently move unrelated legacy or prerelease tags. Publishing is not a host upgrade: restart or reload a user's existing host only with that user's authorization, and start a new session when the release's migration notes require it. Keep release evidence separate from static documentation; a version bump or changelog entry alone is not proof of successful publication.
