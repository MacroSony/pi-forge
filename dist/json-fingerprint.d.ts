/**
 * Forge canonical JSON fingerprints shared by instruction snapshots and the
 * existing subagent wire adapter. The algorithm is unchanged: sorted plain
 * objects, finite numbers, no cycles or sparse arrays. This is content identity,
 * not an authentication signature.
 */
export declare const JSON_FINGERPRINT_PREFIX: "sha256:v1:";
export type JsonFingerprint = `${typeof JSON_FINGERPRINT_PREFIX}${string}`;
export declare function canonicalJson(value: unknown): string;
export declare function fingerprintJson(value: unknown): JsonFingerprint;
//# sourceMappingURL=json-fingerprint.d.ts.map