const OPENING = new Set(["{{", "{%"]);
export function parse(source) {
    const parser = new Parser(source);
    try {
        const ast = parser.parseTop();
        return { ok: true, ast };
    }
    catch (error) {
        if (isForgeError(error))
            return { ok: false, error };
        throw error;
    }
}
class Parser {
    source;
    index = 0;
    constructor(source) {
        this.source = source;
    }
    parseTop() {
        const result = this.parseUntil(new Set());
        return result.nodes;
    }
    parseUntil(stop) {
        const nodes = [];
        while (this.index < this.source.length) {
            const next = this.nextOpening();
            if (!next) {
                if (this.index < this.source.length) {
                    nodes.push(text(this.source.slice(this.index), this.index, this.source.length));
                    this.index = this.source.length;
                }
                break;
            }
            if (next.index > this.index) {
                nodes.push(text(this.source.slice(this.index, next.index), this.index, next.index));
            }
            if (next.delimiter === "{{") {
                nodes.push(this.parseOutput(next.index));
                continue;
            }
            const end = this.source.indexOf("%}", next.index);
            if (end === -1) {
                throw parseError("Unclosed forge-v1 tag", next.index, this.source.length);
            }
            const raw = this.source.slice(next.index + 2, end).trim();
            this.index = end + 2;
            if (raw === "else" || raw === "endif") {
                const kind = raw === "else" ? "else" : "endif";
                if (!stop.has(kind)) {
                    throw parseError(`Unexpected {% ${raw} %}`, next.index, end + 2);
                }
                return { nodes, stop: kind };
            }
            if (raw.startsWith("if ")) {
                if (stop.size > 0) {
                    throw parseError("Nested conditional closes prematurely", next.index, end + 2);
                }
                const predicate = this.parsePredicate(raw.slice(3).trim(), next.index, end + 2);
                const thenResult = this.parseUntil(new Set(["else", "endif"]));
                let elseBody = null;
                if (thenResult.stop === "else") {
                    elseBody = this.parseUntil(new Set(["endif"])).nodes;
                }
                nodes.push({
                    kind: "if",
                    predicate,
                    thenBody: thenResult.nodes,
                    elseBody,
                    span: { start: next.index, end },
                });
                continue;
            }
            throw parseError(`Unsupported forge-v1 tag: {% ${raw} %}`, next.index, end + 2);
        }
        if (stop.size > 0) {
            const expected = [...stop][0];
            throw parseError(`Missing {% ${expected} %}`, this.index, this.source.length);
        }
        return { nodes };
    }
    nextOpening() {
        let best;
        for (const delimiter of ["{{", "{%"]) {
            const index = this.source.indexOf(delimiter, this.index);
            if (index === -1)
                continue;
            if (!best || index < best.index)
                best = { delimiter, index };
        }
        return best;
    }
    parseOutput(start) {
        const end = this.source.indexOf("}}", start);
        if (end === -1) {
            throw parseError("Unclosed output tag {{", start, this.source.length);
        }
        const expression = this.source.slice(start + 2, end).trim();
        this.index = end + 2;
        const parsed = parseOutputExpression(expression, start, end + 2);
        if (parsed.error)
            throw parsed.error;
        return parsed.node;
    }
    parsePredicate(raw, start, end) {
        const eq = matchComparison(raw, "==");
        const ne = eq ? undefined : matchComparison(raw, "!=");
        const op = eq ?? ne;
        if (op) {
            const path = parsePath(op.path);
            if (!path)
                throw parseError(`Invalid predicate path: ${op.path}`, start, end);
            return {
                kind: eq ? "eq" : "ne",
                path,
                expected: op.expected,
                span: { start, end },
            };
        }
        if (!raw)
            throw parseError("Missing predicate in {% if %}", start, end);
        const path = parsePath(raw);
        if (!path)
            throw parseError(`Invalid predicate path: ${raw}`, start, end);
        return { kind: "truthy", path, span: { start, end } };
    }
}
function parseOutputExpression(expression, start, end) {
    if (!expression) {
        return { error: parseError("Empty output tag {{}}", start, end) };
    }
    const parts = expression.split("|").map((part) => part.trim());
    const path = parsePath(parts[0]);
    if (!path) {
        return { error: parseError(`Invalid path: ${parts[0]}`, start, end) };
    }
    const filters = parts.slice(1).filter(Boolean);
    return {
        node: {
            kind: "output",
            path,
            filters,
            span: { start, end },
        },
    };
}
function parsePath(raw) {
    const identifiers = raw.split(".").map((part) => part.trim());
    if (identifiers.length === 0)
        return undefined;
    for (const id of identifiers) {
        if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id))
            return undefined;
    }
    return identifiers;
}
function matchComparison(raw, op) {
    const index = raw.indexOf(op);
    if (index <= 0)
        return undefined;
    const left = raw.slice(0, index).trim();
    const right = raw.slice(index + op.length).trim();
    if (!right)
        return undefined;
    const expected = parseQuotedString(right);
    if (!expected)
        return undefined;
    return { path: left, expected };
}
function parseQuotedString(value) {
    if (value.length < 2)
        return undefined;
    const quote = value[0];
    if (quote !== "\"" && quote !== "'")
        return undefined;
    if (value[value.length - 1] !== quote)
        return undefined;
    return value.slice(1, -1).replace(/\\"/g, "\"").replace(/\\'/g, "'").replace(/\\\\/g, "\\");
}
function text(text, start, end) {
    return { kind: "text", text, span: { start, end } };
}
function parseError(message, start, end) {
    return { kind: "parse", message, span: { start, end } };
}
function isForgeError(value) {
    return !!value && typeof value === "object" && value.kind === "parse";
}
//# sourceMappingURL=parser.js.map