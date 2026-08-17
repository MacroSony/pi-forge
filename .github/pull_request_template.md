## Summary

Describe the outcome and why this change is needed.

## Change classification

- [ ] Local: stays within one accepted component and preserves boundaries/contracts.
- [ ] Boundary-affecting: changes ownership, dependency direction, state, or an application port.
- [ ] Product-affecting: changes features, schemas, persistence, trust, public API, or packages.

Affected components:

Architecture decision or 0.5 plan section (required for boundary/product changes):

## Architecture impact

- [ ] Dependency direction remains valid.
- [ ] Mutable state has one named owner.
- [ ] Domain resources are persisted only through repositories.
- [ ] Commands/HTTP/browser code contains no new domain workflow.
- [ ] Public exports and persisted schemas are unchanged, or migration notes are included.
- [ ] Current/target diagrams remain accurate, or this PR updates them.

## Compatibility and migration

Describe breaking behavior, migration, temporary compatibility code, its named consumer, and its removal condition. Write `None` when not applicable.

## Verification

List tests and checks run. Release-sized and cross-cutting slices should run `npm run verify`.
