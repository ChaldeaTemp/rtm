import type { SessionToolCall, SessionToolDiff } from "../types.js";

export const MAX_TOOL_OUTPUT_CHARS = 4_000;
export const MAX_TOOL_DIFF_CHARS = 4_000;
export const MAX_TOOL_DIFF_COUNT = 4;
export const MAX_TOOL_INPUT_STRING_CHARS = 2_000;
export const MAX_TOOL_INPUT_JSON_CHARS = 4_000;
export const MAX_TOOL_LOCATIONS = 20;

export function clipHeadTail(text: string, limit: number): { value: string; truncated: boolean } {
  if (text.length <= limit) {
    return { value: text, truncated: false };
  }
  const safeLimit = Math.max(0, limit);
  const head = Math.min(text.length, Math.ceil(safeLimit * 0.6));
  const tail = Math.min(text.length - head, Math.max(0, safeLimit - head));
  const omitted = text.length - head - tail;
  const headStr = text.slice(0, head);
  const tailStr = tail > 0 ? text.slice(text.length - tail) : "";
  return {
    value: `${headStr}\n... [已省略中间 ${omitted} 字符，原长 ${text.length} 字符] ...\n${tailStr}`,
    truncated: true,
  };
}

function sanitize(val: unknown, depth: number, ancestors: Set<object>): unknown {
  if (val === null || val === undefined) {
    return val;
  }
  if (typeof val === "string") {
    return val.length > MAX_TOOL_INPUT_STRING_CHARS
      ? clipHeadTail(val, MAX_TOOL_INPUT_STRING_CHARS).value
      : val;
  }
  if (typeof val === "number" || typeof val === "boolean" || typeof val === "bigint") {
    return val;
  }
  if (typeof val === "symbol" || typeof val === "function") {
    return String(val);
  }
  if (typeof val !== "object") {
    return String(val);
  }

  if (val instanceof String || val instanceof Number || val instanceof Boolean) {
    return val.valueOf();
  }
  if (val instanceof Date) {
    return val.toISOString();
  }
  if (val instanceof RegExp) {
    return val.toString();
  }
  if (val instanceof Error) {
    return `${val.name}: ${val.message}`;
  }

  if (ancestors.has(val)) {
    return "[Circular]";
  }

  if (depth >= 4) {
    return Array.isArray(val) ? `[Array(${val.length})]` : "[Object]";
  }

  ancestors.add(val);
  try {
    if (Array.isArray(val)) {
      const result: unknown[] = [];
      const limit = Math.min(val.length, 20);
      for (let i = 0; i < limit; i++) {
        result.push(sanitize(val[i], depth + 1, ancestors));
      }
      if (val.length > 20) {
        result.push(`... [已省略 ${val.length - 20} 项，共 ${val.length} 项]`);
      }
      return result;
    }

    const result: Record<string, unknown> = {};
    const keys = Object.keys(val);
    const limit = Math.min(keys.length, 24);
    for (let i = 0; i < limit; i++) {
      const key = keys[i]!;
      try {
        result[key] = sanitize((val as Record<string, unknown>)[key], depth + 1, ancestors);
      } catch {
        result[key] = "[Unreadable]";
      }
    }
    if (keys.length > 24) {
      result["_omitted"] = `... [已省略 ${keys.length - 24} 个属性，共 ${keys.length} 个属性]`;
    }
    return result;
  } finally {
    ancestors.delete(val);
  }
}

export function compactToolRawInput(rawInput: unknown): unknown {
  if (rawInput === undefined || rawInput === null) {
    return rawInput;
  }
  const compacted = sanitize(rawInput, 0, new Set<object>());
  try {
    const serialized = JSON.stringify(compacted);
    if (typeof serialized === "string" && serialized.length > MAX_TOOL_INPUT_JSON_CHARS) {
      return clipHeadTail(serialized, MAX_TOOL_INPUT_JSON_CHARS).value;
    }
  } catch {
    // Return compacted if serialization fails
  }
  return compacted;
}

export function compactToolCall(tc: SessionToolCall): SessionToolCall {
  let rawInput = tc.rawInput;
  if (rawInput !== undefined) {
    rawInput = compactToolRawInput(rawInput);
  }

  let outputText = tc.outputText;
  let outputTruncated = tc.outputTruncated;
  if (typeof outputText === "string") {
    const clipped = clipHeadTail(outputText, MAX_TOOL_OUTPUT_CHARS);
    outputText = clipped.value;
    if (clipped.truncated) {
      outputTruncated = true;
    }
  }

  let diffs = tc.diffs;
  if (Array.isArray(diffs)) {
    diffs = diffs.slice(0, MAX_TOOL_DIFF_COUNT).map((d): SessionToolDiff => {
      let oldText = d.oldText;
      let oldTruncated = false;
      if (typeof oldText === "string") {
        const clippedOld = clipHeadTail(oldText, MAX_TOOL_DIFF_CHARS);
        oldText = clippedOld.value;
        oldTruncated = clippedOld.truncated;
      }
      let newText = d.newText;
      let newTruncated = false;
      if (typeof newText === "string") {
        const clippedNew = clipHeadTail(newText, MAX_TOOL_DIFF_CHARS);
        newText = clippedNew.value;
        newTruncated = clippedNew.truncated;
      }
      const truncated = Boolean(d.truncated || oldTruncated || newTruncated);
      return {
        ...d,
        ...(oldText !== undefined ? { oldText } : {}),
        newText,
        ...(truncated ? { truncated: true } : d.truncated !== undefined ? { truncated: d.truncated } : {}),
      };
    });
  }

  let locations = tc.locations;
  if (Array.isArray(locations) && locations.length > MAX_TOOL_LOCATIONS) {
    locations = locations.slice(0, MAX_TOOL_LOCATIONS);
  }

  return {
    ...tc,
    ...(rawInput !== undefined ? { rawInput } : {}),
    ...(outputText !== undefined ? { outputText } : {}),
    ...(outputTruncated !== undefined ? { outputTruncated } : {}),
    ...(diffs !== undefined ? { diffs } : {}),
    ...(locations !== undefined ? { locations } : {}),
  };
}
