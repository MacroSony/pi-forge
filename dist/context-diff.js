/**
 * Host-neutral context diff engine.
 *
 * Pure functions only: no DOM, no Vue, no Node APIs. Consecutive turn
 * snapshots are compared with a simple prefix-walk that models KV-cache
 * reuse without attempting a full Myers diff.
 */
/** Estimate tokens from characters using the same chars/4 approximation as payload capture. */
export function estimateApproxTokens(text) {
    return Math.max(1, Math.ceil(text.length / 4));
}
/** Pure string hash used as the block identity shortcut. */
export function hashText(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}
export function createBlock(key, role, text, serialized) {
    const hashInput = serialized === undefined
        ? { role, text }
        : { role, text, serialized };
    const serializedHashInput = stringifyHashInput(hashInput);
    return {
        key,
        role,
        text,
        chars: text.length,
        approxTokens: estimateApproxTokens(text),
        hash: hashText(serializedHashInput),
    };
}
export function createTurnSnapshot(input) {
    return {
        turnId: input.turnId,
        capturedAt: input.capturedAt ?? "",
        stackId: input.stackId ?? "",
        blocks: input.blocks ?? [],
    };
}
export function turnApproxTokens(turn) {
    const chars = turn.blocks.reduce((sum, block) => sum + block.chars, 0);
    return chars === 0 ? 0 : Math.ceil(chars / 4);
}
function commonPrefixLength(a, b) {
    const max = Math.min(a.length, b.length);
    let index = 0;
    while (index < max && a.charCodeAt(index) === b.charCodeAt(index)) {
        index++;
    }
    return index;
}
function stringifyHashInput(value) {
    try {
        const serialized = JSON.stringify(value);
        return serialized === undefined ? String(value) : serialized;
    }
    catch {
        return String(value);
    }
}
/**
 * A block hash includes fields that affect the provider wire request, while
 * the visible block text remains the useful prompt excerpt. When a hash
 * differs because metadata changed without changing the excerpt, no part of
 * that excerpt is safe to count as a reusable prefix.
 */
function safeCommonPrefixLength(before, after) {
    if (before.role !== after.role || before.text === after.text)
        return 0;
    return commonPrefixLength(before.text, after.text);
}
function classify(before, after) {
    if (before && after) {
        if (before.hash === after.hash) {
            return { status: "same", before, after, tokenDelta: 0 };
        }
        return {
            status: "modified",
            before,
            after,
            tokenDelta: after.approxTokens - before.approxTokens,
        };
    }
    if (before) {
        return { status: "removed", before, tokenDelta: -before.approxTokens };
    }
    return { status: "added", after, tokenDelta: after?.approxTokens ?? 0 };
}
function summarize(blocks, netTokens) {
    let sameBlocks = 0;
    let addedBlocks = 0;
    let removedBlocks = 0;
    let modifiedBlocks = 0;
    let addedTokens = 0;
    let removedTokens = 0;
    for (const block of blocks) {
        switch (block.status) {
            case "same":
                sameBlocks++;
                break;
            case "added":
                addedBlocks++;
                addedTokens += block.after?.approxTokens ?? 0;
                break;
            case "removed":
                removedBlocks++;
                removedTokens += block.before?.approxTokens ?? 0;
                break;
            case "modified":
                modifiedBlocks++;
                if (block.tokenDelta > 0) {
                    addedTokens += block.tokenDelta;
                }
                else {
                    removedTokens += -block.tokenDelta;
                }
                break;
        }
    }
    const classifiedNetTokens = addedTokens - removedTokens;
    if (classifiedNetTokens < netTokens) {
        addedTokens += netTokens - classifiedNetTokens;
    }
    else if (classifiedNetTokens > netTokens) {
        removedTokens += classifiedNetTokens - netTokens;
    }
    return {
        sameBlocks,
        addedBlocks,
        removedBlocks,
        modifiedBlocks,
        changedBlocks: addedBlocks + removedBlocks + modifiedBlocks,
        addedTokens,
        removedTokens,
        netTokens,
    };
}
function hasUniqueStableKeys(blocks) {
    const keys = blocks.map((block) => block.key);
    return keys.every((key) => key.length > 0) && new Set(keys).size === keys.length;
}
function alignBlocks(beforeBlocks, afterBlocks) {
    const afterKeys = new Set(afterBlocks.map((block) => block.key));
    const useKeys = hasUniqueStableKeys(beforeBlocks)
        && hasUniqueStableKeys(afterBlocks)
        && beforeBlocks.some((block) => afterKeys.has(block.key));
    if (!useKeys) {
        const maxLength = Math.max(beforeBlocks.length, afterBlocks.length);
        return Array.from({ length: maxLength }, (_, index) => ({
            before: beforeBlocks[index],
            after: afterBlocks[index],
        }));
    }
    const beforeByKey = new Map(beforeBlocks.map((block) => [block.key, block]));
    const beforeIndexByKey = new Map(beforeBlocks.map((block, index) => [block.key, index]));
    const aligned = [];
    let beforeCursor = 0;
    for (const after of afterBlocks) {
        const before = beforeByKey.get(after.key);
        if (!before) {
            aligned.push({ after });
            continue;
        }
        const beforeIndex = beforeIndexByKey.get(after.key);
        while (beforeCursor < beforeIndex) {
            const skipped = beforeBlocks[beforeCursor];
            if (!afterKeys.has(skipped.key))
                aligned.push({ before: skipped });
            beforeCursor++;
        }
        aligned.push({ before, after });
        beforeCursor = Math.max(beforeCursor, beforeIndex + 1);
    }
    while (beforeCursor < beforeBlocks.length) {
        const before = beforeBlocks[beforeCursor];
        if (!afterKeys.has(before.key))
            aligned.push({ before });
        beforeCursor++;
    }
    return aligned;
}
/**
 * Diff two consecutive turn snapshots.
 *
 * The cache-boundary walk compares block arrays positionally while hashes
 * match. This preserves the serialized-prefix meaning even when a later
 * block is moved. Classification uses stable block keys after the boundary so
 * a middle insertion does not make every following block look modified.
 */
export function diffTurns(previous, current) {
    const beforeBlocks = previous?.blocks ?? [];
    const afterBlocks = current.blocks;
    const diffBlocks = alignBlocks(beforeBlocks, afterBlocks).map(({ before, after }) => classify(before, after));
    let prefixChars = 0;
    let boundaryCrossed = false;
    for (let index = 0; index < Math.max(beforeBlocks.length, afterBlocks.length); index++) {
        const before = beforeBlocks[index];
        const after = afterBlocks[index];
        if (!boundaryCrossed) {
            if (before && after && before.hash === after.hash) {
                prefixChars += after.chars;
                continue;
            }
            if (before && after) {
                prefixChars += safeCommonPrefixLength(before, after);
            }
            boundaryCrossed = true;
        }
    }
    const currentTokens = turnApproxTokens(current);
    const previousTokens = previous ? turnApproxTokens(previous) : 0;
    const currentChars = afterBlocks.reduce((sum, block) => sum + block.chars, 0);
    const prefixTokens = !boundaryCrossed || prefixChars >= currentChars
        ? currentTokens
        : Math.min(currentTokens, Math.floor(prefixChars / 4));
    const deltaTokens = currentTokens - previousTokens;
    const prefixRatio = currentTokens === 0 ? 0 : prefixTokens / currentTokens;
    return {
        blocks: diffBlocks,
        prefixTokens,
        prefixRatio,
        deltaTokens,
        summary: summarize(diffBlocks, deltaTokens),
    };
}
//# sourceMappingURL=context-diff.js.map