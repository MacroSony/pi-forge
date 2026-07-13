export declare class EditorApiError extends Error {
    readonly status: number;
    constructor(message: string, status: number);
}
export type EditorRequestInit = Omit<RequestInit, "body"> & {
    body?: BodyInit | object;
};
export declare function createEditorApi(token: string): <T = any>(path: string, options?: EditorRequestInit) => Promise<T>;
//# sourceMappingURL=api.d.ts.map