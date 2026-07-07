export function assertRegistryName(kind, name) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name)) {
        throw new Error(`${kind} name must start with a letter and contain only letters, numbers, underscore, dot, or hyphen: ${name}`);
    }
}
//# sourceMappingURL=extension-registry.js.map