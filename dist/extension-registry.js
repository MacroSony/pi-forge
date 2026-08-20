export function assertRegistryName(kind, name) {
    // Names must be a single template-path segment: forge-v1 uses "." as the
    // path separator, so a dotted name ("git.branch") could be registered but
    // never addressed — "extensions.git.branch" parses as three segments.
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
        throw new Error(`${kind} name must start with a letter and contain only letters, numbers, underscore, or hyphen: ${name}`);
    }
}
//# sourceMappingURL=extension-registry.js.map