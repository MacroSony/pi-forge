# Release process

[Documentation](../README.md)

## Before release

1. Confirm the changelog and user documentation describe the intended version and experimental surfaces accurately.
2. Publish and smoke-test any required `@zihanw/pi-subagent-runtime` version first.
3. Install dependencies from the lockfile and run `npm run verify`.
4. Test a packed installation against the documented minimum and current Pi versions.
5. Exercise ordinary stack/profile use independently of delegation.
6. Exercise both configured foreground backends and confirm unsupported host capabilities fail closed before provider transport.
7. Inspect `npm pack --dry-run` for package size and unexpected or missing files.

## Dependency policy

Published manifests use wildcard peer dependencies for Pi-host-provided SDK packages. Exact versions belong in development dependencies and the lockfile so tests are reproducible without restricting compatible host releases.

`pi-subagent-runtime` remains a normal exact dependency until its compatibility policy says otherwise. Its own host-facing Pi dependencies must follow the same host-provided peer model.

## Package contents

The tarball must include compiled `dist/`, examples, the English and Chinese landing pages, changelog, license, and user/reference documentation. It must not include physical `src/` files. Both the default extension entry and experimental subagent entry must resolve to compiled output.

The root `PUBLIC_API.md` and `SUBAGENT_ADAPTER_CONTRACT.md` files are compatibility pointers; authoritative content lives under `docs/reference/`.

## Publish and verify

Publish the intended version/tag, then install it through Pi in a clean project. Verify `/preset`, `/profile`, `/preset ui`, and—when deliberately enabled—delegation. Restart Pi after installation to avoid testing a stale extension instance.

For a stable release, ensure npm `latest` points to the new version and any prerelease channel no longer leaves users on an incompatible older build.
