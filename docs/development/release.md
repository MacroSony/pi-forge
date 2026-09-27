# Release process

[Documentation](../README.md)

## Independent packages

The main `@zihanw/pi-forge` package has **no** dependency on `@zihanw/pi-forge-subagents` or `@zihanw/pi-subagent-runtime`. It can release independently; unfinished optional features do not block ordinary Forge use or a main-package release.

The optional package is tested against the released Forge host before its own publication. Any required runtime version must be published and smoke-tested before publishing the optional package that depends on it. Backend, continuation, background-task, and nested-usage producer acceptance belong to that companion release, not to the main package.

## Before main-package release

1. Confirm the intended version in the manifest, lockfile, changelog, and current user documentation. Preserve historical release records and document breaking configuration/session boundaries.
2. Install dependencies from the lockfile with `npm ci`, build, and run the complete `npm run verify` chain: Node tests, browser tests, types, generated client, docs, distribution, package contents, and packed installation.
3. Require the Ubuntu, macOS, Windows, and configured Pi compatibility GitHub Actions jobs to pass for the **exact release commit**, not an earlier source revision.
4. Test a packed main-package installation against both the documented minimum and current tested Pi versions; exercise ordinary Preset/Profile/Capability behavior independently of optional delegation.
5. Inspect `npm pack --dry-run` for package size and unexpected or missing files. Publish the verified artifact, not an unreviewed working tree.

The macOS and Windows jobs run the same complete verification surface as Linux, including the real-browser editor suite. Compatibility-version and scheduled latest-Pi probes remain Linux-only; they test dependency drift rather than operating-system behavior.

## Dependency policy

The four Pi SDK packages remain host-provided optional peers, never private runtime dependencies. Forge 0.5.6 requires Pi `>=0.87.0 <0.88.0`, with development fixtures pinned to `0.87.0`; `typebox` remains a wildcard optional peer. Pi 0.86 and future minor versions are not implicitly supported. Exact tested versions belong in development dependencies and the lockfile, not exact host-version requirements.

Published `@zihanw/pi-forge-subagents` 0.5.3 does not understand `tools.initial`. The upcoming optional package needs the matching fix and a Forge dependency floor of `^0.5.5` for the new command-contribution entry. This is a companion compatibility gate, not a requirement to publish the packages simultaneously. See the [host-port compatibility note](../reference/subagent-host-port.md#tool-selection-compatibility).

## Package contents

The tarball must include compiled `dist/`, examples, the English and Chinese landing pages, changelog, license, and user/reference documentation. It must not include physical `src/` files. The root, `/subagent`, `/ui-contribution`, and `/command-contribution` entries must resolve to compiled output.

The root `PUBLIC_API.md` and `SUBAGENT_ADAPTER_CONTRACT.md` files are compatibility pointers; authoritative content lives under `docs/reference/`.

## Publish and verify

With release authorization, publish the intended version using the intended tag (`latest` for a stable main-package release). Verify registry version, tag, and tarball integrity, then install the published package through Pi in a clean project and smoke-test the main commands and resource workflow without model inference.

Do not silently move unrelated legacy or prerelease tags. Publishing is not a host upgrade: restart or reload a user's existing host only with that user's authorization, and start a new session when the release's migration notes require it. Keep release evidence separate from static documentation; a version bump or changelog entry alone is not proof of successful publication.
