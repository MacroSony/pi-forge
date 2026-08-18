import { analyze } from "./analyzer.js";
import { parse } from "./parser.js";
import { render } from "./renderer.js";
import { FORGE_V1_FILTERS, FORGE_V1_MAX_EXTENSION_OUTPUT, FORGE_V1_MAX_TEMPLATE_OUTPUT, } from "./types.js";
export const forgeV1 = {
    id: "forge-v1",
    version: 1,
    parse: parse,
    analyze: (nodes) => analyze(nodes),
    render: render,
};
export { FORGE_V1_FILTERS, FORGE_V1_MAX_EXTENSION_OUTPUT, FORGE_V1_MAX_TEMPLATE_OUTPUT, };
//# sourceMappingURL=index.js.map