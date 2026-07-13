export interface EditorElement extends HTMLElement {
    value: string;
    checked: boolean;
    disabled: boolean;
    files: FileList | null;
}
export declare function el<T extends HTMLElement = EditorElement>(id: string): T;
export declare function query<T extends Element = EditorElement>(root: ParentNode, selector: string): T | null;
export declare function queryAll<T extends Element = EditorElement>(root: ParentNode, selector: string): NodeListOf<T>;
export declare function eventElement(event: Event): EditorElement;
export declare function escapeHtml(value: unknown): string;
export declare function attr(value: unknown): string;
//# sourceMappingURL=dom.d.ts.map