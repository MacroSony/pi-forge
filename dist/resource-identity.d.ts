export type ResourceScope = "global" | "project";
export interface ResourceKey {
    scope: ResourceScope;
    id: string;
}
export interface ResourceSelector {
    scope?: ResourceScope;
    id: string;
}
/**
 * Unified resource ID grammar shared by agent profiles and prompt stacks.
 * `:` is reserved for scope qualification and must not appear in JSON IDs.
 */
export declare const RESOURCE_ID_PATTERN: RegExp;
export type ResourceSelectorParseResult = {
    ok: true;
    selector: ResourceSelector;
} | {
    ok: false;
    error: string;
};
export declare function isValidResourceId(id: string): boolean;
export declare function isResourceScope(value: unknown): value is ResourceScope;
export declare function resourceKey(scope: ResourceScope, id: string): ResourceKey;
export declare function formatResourceKey(key: ResourceKey): string;
export declare function formatResourceSelector(selector: ResourceSelector): string;
/**
 * Parse a selector into `{ scope?, id }`. Rejects unknown scope prefixes,
 * empty IDs, and malformed selectors. Bare `none`/`off` are opt-outs and
 * should be handled by the caller before selector parsing.
 */
export declare function parseResourceSelector(input: string): ResourceSelectorParseResult;
//# sourceMappingURL=resource-identity.d.ts.map