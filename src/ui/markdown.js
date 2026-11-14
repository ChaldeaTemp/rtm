// Pure ESM markdown, syntax highlighting, inline preview, unified diff, and retry-fold helpers.
// Safe to import in both the browser UI and Node/tsx verification scripts.

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getRuntimeThemeDark(explicitDark) {
  if (typeof explicitDark === "boolean") return explicitDark;
  if (typeof document !== "undefined") {
    if (document.body?.classList?.contains("dark")) return true;
    if (document.documentElement?.dataset?.theme === "dark") return true;
  }
  return false;
}

function getRuntimeSkin(explicitSkin) {
  if (typeof explicitSkin === "string" && explicitSkin) return explicitSkin;
  if (typeof document !== "undefined") {
    return document.body?.dataset?.skin || document.documentElement?.dataset?.skin || "classic";
  }
  return "classic";
}

function getRuntimeOrigin(explicitOrigin) {
  if (typeof explicitOrigin === "string") return explicitOrigin;
  if (typeof location !== "undefined" && location.origin && location.origin !== "null") {
    return location.origin;
  }
  return "";
}

export function looksLikeHtmlDoc(rawCode) {
  const s = String(rawCode || "").trim();
  if (!s) return false;
  if (/^<!doctype\s+html/i.test(s)) return true;
  if (/^<html[\s>]/i.test(s)) return true;
  if (/^<svg[\s>]/i.test(s) && /<\/svg>\s*$/i.test(s)) return true;
  if (/<(body|head|style|script|canvas|svg|main|section|article|div|table)\b/i.test(s) && /<\/[a-z]+>/i.test(s)) {
    return true;
  }
  return false;
}

export function buildInlinePreviewSrcdoc(lang, rawCode, opts = {}) {
  const dark = getRuntimeThemeDark(opts.dark);
  const skin = getRuntimeSkin(opts.skin);
  const origin = getRuntimeOrigin(opts.origin);
  const code = String(rawCode || "");
  const normalizedLang = String(lang || "").trim().toLowerCase();

  const palette = dark
    ? {
        bg: skin === "roundtable" ? "#161412" : "#111318",
        surface: skin === "roundtable" ? "#1f1c18" : "#181c24",
        fg: "#e8eaed",
        muted: "#9aa3b2",
        border: "#2d3340",
        accent: "#7aa2f7",
      }
    : {
        bg: skin === "roundtable" ? "#f4f1ea" : "#faf9f6",
        surface: "#ffffff",
        fg: "#1f2328",
        muted: "#5f6672",
        border: "#d8dde6",
        accent: "#2563eb",
      };

  const baseCss = `<style>
:root { color-scheme: ${dark ? "dark" : "light"}; }
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 12px;
  background: ${palette.bg};
  color: ${palette.fg};
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  line-height: 1.5;
}
a { color: ${palette.accent}; }
svg { max-width: 100%; height: auto; }
.mermaid-error {
  border: 1px solid ${palette.border};
  background: ${palette.surface};
  padding: 10px;
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
  white-space: pre-wrap;
}
</style>`;

  if (normalizedLang === "mermaid") {
    const mermaidSrc = `${origin}/ui/vendor/mermaid.min.js`;
    const mermaidTheme = dark ? "dark" : "default";
    return `<!doctype html>
<html data-theme="${dark ? "dark" : "light"}" data-skin="${escapeHtml(skin)}">
<head>
<meta charset="utf-8" />
${baseCss}
<style>
body { display: flex; justify-content: center; align-items: flex-start; min-height: 100%; overflow: auto; }
.mermaid { width: 100%; text-align: center; }
</style>
<script src="${escapeHtml(mermaidSrc)}"></script>
</head>
<body>
<div class="mermaid" id="mmdTarget">${escapeHtml(code)}</div>
<script>
(async function () {
  const el = document.getElementById("mmdTarget");
  if (!window.mermaid || !el) return;
  try {
    window.mermaid.initialize({ startOnLoad: false, theme: ${JSON.stringify(mermaidTheme)}, securityLevel: "strict" });
    await window.mermaid.run({ nodes: [el] });
  } catch (err) {
    el.className = "mermaid-error";
    el.textContent = "Mermaid render error: " + (err && err.message ? err.message : String(err)) + "\\n\\n" + ${JSON.stringify(code)};
  }
})();
</script>
</body>
</html>`;
  }

  if (normalizedLang === "svg") {
    return `<!doctype html>
<html data-theme="${dark ? "dark" : "light"}" data-skin="${escapeHtml(skin)}">
<head><meta charset="utf-8" />${baseCss}
<style>body { display: flex; justify-content: center; align-items: center; min-height: 100vh; }</style>
</head>
<body>${code}</body>
</html>`;
  }

  // HTML document or fragment
  if (/<!doctype|<html[\s>]/i.test(code)) {
    const themeScript = `<script>document.documentElement.dataset.theme=${JSON.stringify(dark ? "dark" : "light")};document.documentElement.dataset.skin=${JSON.stringify(skin)};</script>`;
    const inject = `${baseCss}${themeScript}`;
    if (/<\/head>/i.test(code)) {
      return code.replace(/<\/head>/i, `${inject}</head>`);
    }
    return `${inject}${code}`;
  }

  return `<!doctype html>
<html data-theme="${dark ? "dark" : "light"}" data-skin="${escapeHtml(skin)}">
<head><meta charset="utf-8" />${baseCss}</head>
<body>${code}</body>
</html>`;
}

// Single-pass syntax tokenizer; avoids corrupting previously emitted <span> markup.
const CODE_KW_SET = new Set([
  "async", "await", "break", "case", "catch", "class", "const", "continue",
  "debugger", "default", "defer", "def", "delete", "do", "elif", "else", "enum",
  "export", "extends", "false", "finally", "fn", "for", "from", "func",
  "function", "global", "go", "if", "impl", "import", "in", "instanceof",
  "interface", "let", "loop", "match", "mod", "mut", "namespace", "new",
  "nil", "None", "null", "package", "pass", "private", "protected", "pub",
  "public", "raise", "readonly", "return", "self", "select", "static",
  "struct", "super", "switch", "this", "throw", "true", "True", "False",
  "try", "type", "typeof", "undefined", "use", "var", "void", "while",
  "with", "yield", "SELECT", "FROM", "WHERE", "INSERT", "INTO", "UPDATE",
  "DELETE", "CREATE", "TABLE", "JOIN", "LEFT", "RIGHT", "ON", "GROUP", "BY",
  "ORDER", "LIMIT", "AS", "AND", "OR", "NOT", "NULL",
]);

const CODE_TOKEN_RE =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`)|(\b0x[0-9a-fA-F_]+\b|\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|(\b[A-Za-z_$][A-Za-z0-9_$]*\b)/g;

export function highlightCode(lang, code) {
  const normalizedLang = String(lang || "").trim().toLowerCase();
  if (normalizedLang === "diff" || normalizedLang === "patch") {
    return String(code || "")
      .split("\n")
      .map((line) => {
        const safe = escapeHtml(line);
        if (/^(diff --git|index |--- |\+\+\+ )/.test(line)) {
          return `<span class="diff-line-meta">${safe}</span>`;
        }
        if (line.startsWith("@@")) {
          return `<span class="diff-line-hunk">${safe}</span>`;
        }
        if (line.startsWith("+")) {
          return `<span class="diff-line-add">${safe}</span>`;
        }
        if (line.startsWith("-")) {
          return `<span class="diff-line-del">${safe}</span>`;
        }
        return safe;
      })
      .join("\n");
  }

  const text = String(code || "");
  let out = "";
  let lastIdx = 0;
  CODE_TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = CODE_TOKEN_RE.exec(text)) !== null) {
    if (match.index > lastIdx) {
      out += escapeHtml(text.slice(lastIdx, match.index));
    }
    const [full, cmt, str, num, ident] = match;
    if (cmt) {
      out += `<span class="tok-cmt">${escapeHtml(cmt)}</span>`;
    } else if (str) {
      out += `<span class="tok-str">${escapeHtml(str)}</span>`;
    } else if (num) {
      out += `<span class="tok-num">${escapeHtml(num)}</span>`;
    } else if (ident) {
      if (CODE_KW_SET.has(ident)) {
        out += `<span class="tok-kw">${escapeHtml(ident)}</span>`;
      } else if (/^[A-Z][A-Za-z0-9_]*$/.test(ident)) {
        out += `<span class="tok-type">${escapeHtml(ident)}</span>`;
      } else {
        out += escapeHtml(ident);
      }
    } else {
      out += escapeHtml(full);
    }
    lastIdx = CODE_TOKEN_RE.lastIndex;
  }
  if (lastIdx < text.length) {
    out += escapeHtml(text.slice(lastIdx));
  }
  return out;
}

function isSafeLinkUrl(url) {
  const trimmed = String(url || "").trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("#") || trimmed.startsWith("/artifacts/")) return true;
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (/^file:\/\/\//i.test(trimmed)) return true;
  return false;
}

function renderInline(rawText) {
  const placeholders = [];
  let text = String(rawText || "");

  // Extract inline code spans first so inner symbols are never parsed as emphasis/links.
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => {
    const idx = placeholders.length;
    placeholders.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000CODE_${idx}\u0000`;
  });

  // Extract markdown links before HTML escaping so URL characters keep structure cleanly.
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+(?:\s+"[^"]*")?)\)/g, (full, label, rawDest) => {
    const dest = rawDest.replace(/\s+"[^"]*"$/, "");
    if (!isSafeLinkUrl(dest)) return full;
    const idx = placeholders.length;
    const innerLabel = formatInlineEmphasis(escapeHtml(label));
    placeholders.push(
      `<a href="${escapeHtml(dest)}" target="_blank" rel="noopener noreferrer">${innerLabel}</a>`
    );
    return `\u0000CODE_${idx}\u0000`;
  });

  text = escapeHtml(text);

  // Auto-link bare http(s) URLs outside markdown links/code spans.
  text = text.replace(/(^|[\s(>])((?:https?:\/\/)[^\s<)]+)/g, (_m, prefix, rawUrl) => {
    const trailMatch = rawUrl.match(/([.,!?;:]+)$/);
    const cleanUrl = trailMatch ? rawUrl.slice(0, -trailMatch[1].length) : rawUrl;
    const trail = trailMatch ? trailMatch[1] : "";
    return `${prefix}<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer">${cleanUrl}</a>${trail}`;
  });

  text = formatInlineEmphasis(text);

  return text.replace(/\u0000CODE_(\d+)\u0000/g, (_m, idxStr) => placeholders[Number(idxStr)] || "");
}

function formatInlineEmphasis(escaped) {
  let out = escaped;
  out = out.replace(/~~([^~\n]+?)~~/g, "<del>$1</del>");
  out = out.replace(/\*\*([^\n*](?:[^\n]*?[^\n*])?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^\n_](?:[^\n]*?[^\n_])?)__/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^_\w])_([^_\n]+?)_(?!_)/g, "$1<em>$2</em>");
  return out;
}

function isTableSeparatorLine(line) {
  const trimmed = line.trim();
  if (!trimmed.includes("|") && !/^:?-{3,}:?$/.test(trimmed)) return false;
  const cells = splitTableRow(trimmed);
  if (cells.length === 0) return false;
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function parseTableAlignments(sepLine) {
  return splitTableRow(sepLine).map((cell) => {
    const c = cell.trim();
    if (c.startsWith(":") && c.endsWith(":")) return "center";
    if (c.endsWith(":")) return "right";
    if (c.startsWith(":")) return "left";
    return "";
  });
}

function isHrLine(line) {
  return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line);
}

function matchListLine(line) {
  const m = line.match(/^([ ]*)([-*+]|\d+[.)])\s+(.*)$/);
  if (!m) return null;
  const indent = m[1].length;
  const marker = m[2];
  const ordered = /^\d/.test(marker);
  let text = m[3];
  let taskState = null;
  const taskMatch = text.match(/^\[( |x|X)\]\s+(.*)$/);
  if (taskMatch) {
    taskState = taskMatch[1].toLowerCase() === "x";
    text = taskMatch[2];
  }
  return { indent, ordered, text, taskState };
}

function matchFenceOpen(line) {
  const m = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
  if (!m) return null;
  const fence = m[1];
  const lang = m[2].trim().split(/\s+/)[0] || "";
  return { char: fence[0], len: fence.length, lang };
}

function isHeadingLine(line) {
  return /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.test(line);
}

function renderCodeBlockHtml(lang, code, opts) {
  const normalizedLang = String(lang || "").trim().toLowerCase();
  const canPreview =
    normalizedLang === "mermaid" ||
    normalizedLang === "svg" ||
    ((normalizedLang === "html" || normalizedLang === "htm") && looksLikeHtmlDoc(code));

  const codeB64 = encodeUtf8Base64(code);
  const highlighted = highlightCode(normalizedLang, code);
  const langBadge = escapeHtml(lang || "text");

  let previewHtml = "";
  let toggleBtnHtml = "";
  if (canPreview) {
    const srcdoc = buildInlinePreviewSrcdoc(normalizedLang, code, opts);
    const defaultOpen = normalizedLang === "mermaid" || normalizedLang === "svg";
    toggleBtnHtml = `<button class="md-preview-toggle" type="button" data-preview-toggle>${defaultOpen ? "查看源码" : "实时预览"}</button>`;
    previewHtml = `<div class="md-preview-box"${defaultOpen ? "" : " hidden"}>
      <iframe class="md-preview-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escapeHtml(srcdoc)}"></iframe>
    </div>`;
  }

  const codeHiddenAttr =
    canPreview && (normalizedLang === "mermaid" || normalizedLang === "svg") ? " hidden" : "";

  return `<div class="md-code-block" data-code-b64="${escapeHtml(codeB64)}" data-code-lang="${langBadge}">
    <div class="md-code-head">
      <span class="md-code-lang">${langBadge}</span>
      <div class="md-code-actions">
        ${toggleBtnHtml}
        <button class="md-copy-btn" type="button" data-copy-code>复制</button>
      </div>
    </div>
    ${previewHtml}
    <pre class="md-code-pre"${codeHiddenAttr}><code>${highlighted}</code></pre>
  </div>`;
}

function encodeUtf8Base64(text) {
  try {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(String(text || ""), "utf8").toString("base64");
    }
    const bytes = new TextEncoder().encode(String(text || ""));
    let bin = "";
    for (let i = 0; i < bytes.length; i++) {
      bin += String.fromCharCode(bytes[i]);
    }
    return btoa(bin);
  } catch {
    return "";
  }
}

export function decodeUtf8Base64(b64) {
  try {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(String(b64 || ""), "base64").toString("utf8");
    }
    const bin = atob(String(b64 || ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

const ALERT_TITLES = {
  NOTE: "提示",
  TIP: "建议",
  IMPORTANT: "重要",
  WARNING: "注意",
  CAUTION: "警告",
};

function renderBlockquote(rawLines, opts) {
  const first = rawLines[0] || "";
  const alertMatch = first.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
  if (alertMatch) {
    const kind = alertMatch[1].toUpperCase();
    const restFirst = alertMatch[2] ? [alertMatch[2]] : [];
    const bodyLines = [...restFirst, ...rawLines.slice(1)];
    const bodyHtml = renderMarkdown(bodyLines.join("\n"), opts);
    return `<div class="md-alert md-alert-${kind.toLowerCase()}">
      <div class="md-alert-title">${ALERT_TITLES[kind] || kind}</div>
      <div class="md-alert-body">${bodyHtml}</div>
    </div>`;
  }
  return `<blockquote>${renderMarkdown(rawLines.join("\n"), opts)}</blockquote>`;
}

function renderListBlock(items) {
  // Build nested list HTML using an indent stack.
  const stack = [];
  let html = "";

  const openList = (ordered, indent) => {
    const tag = ordered ? "ol" : "ul";
    html += `<${tag}>`;
    stack.push({ tag, ordered, indent, liOpen: false });
  };

  const closeTopLi = (top) => {
    if (top && top.liOpen) {
      html += "</li>";
      top.liOpen = false;
    }
  };

  const closeTopList = () => {
    const top = stack.pop();
    if (!top) return;
    closeTopLi(top);
    html += `</${top.tag}>`;
  };

  for (const item of items) {
    while (stack.length > 0 && item.indent < stack[stack.length - 1].indent) {
      closeTopList();
    }

    let top = stack[stack.length - 1];
    if (!top) {
      openList(item.ordered, item.indent);
      top = stack[stack.length - 1];
    } else if (item.indent > top.indent) {
      // Nested under current <li> if one is open; otherwise open parallel list.
      openList(item.ordered, item.indent);
      top = stack[stack.length - 1];
    } else if (item.ordered !== top.ordered && stack.length === 1) {
      closeTopList();
      openList(item.ordered, item.indent);
      top = stack[stack.length - 1];
    } else {
      closeTopLi(top);
    }

    const body = item.bodyLines.map((l) => renderInline(l)).join("<br>");
    if (item.taskState !== null) {
      html += `<li class="md-task-item"><input type="checkbox" disabled${item.taskState ? " checked" : ""} /><span>${body}</span>`;
    } else {
      html += `<li>${body}`;
    }
    top.liOpen = true;
  }

  while (stack.length > 0) {
    closeTopList();
  }
  return html;
}

export function renderMarkdown(raw, opts = {}) {
  const source = String(raw ?? "").replace(/\r\n?/g, "\n");
  if (!source.trim()) return "";

  const lines = source.split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip blank lines
    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code block
    const fence = matchFenceOpen(line);
    if (fence) {
      const codeLines = [];
      i++;
      while (i < lines.length) {
        const cur = lines[i];
        const closeMatch = cur.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
        if (closeMatch && closeMatch[1][0] === fence.char && closeMatch[1].length >= fence.len) {
          i++;
          break;
        }
        codeLines.push(cur);
        i++;
      }
      blocks.push(renderCodeBlockHtml(fence.lang, codeLines.join("\n"), opts));
      continue;
    }

    // ATX Heading (works without preceding blank line)
    const headingMatch = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      blocks.push(`<h${level}>${renderInline(headingMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (isHrLine(line)) {
      blocks.push("<hr />");
      i++;
      continue;
    }

    // Blockquote / GitHub Alert
    if (/^\s{0,3}>\s?/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
        i++;
      }
      blocks.push(renderBlockquote(quoteLines, opts));
      continue;
    }

    // GFM Table
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      isTableSeparatorLine(lines[i + 1])
    ) {
      const headers = splitTableRow(line);
      const alignments = parseTableAlignments(lines[i + 1]);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      const ths = headers
        .map((h, idx) => {
          const align = alignments[idx] ? ` style="text-align:${alignments[idx]}"` : "";
          return `<th${align}>${renderInline(h)}</th>`;
        })
        .join("");
      const trs = rows
        .map((row) => {
          const tds = headers
            .map((_h, idx) => {
              const align = alignments[idx] ? ` style="text-align:${alignments[idx]}"` : "";
              return `<td${align}>${renderInline(row[idx] ?? "")}</td>`;
            })
            .join("");
          return `<tr>${tds}</tr>`;
        })
        .join("");
      blocks.push(
        `<div class="md-table-wrap"><table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`
      );
      continue;
    }

    // List (supports nested indentation + task list + single blank-line continuation)
    const firstList = matchListLine(line);
    if (firstList) {
      const items = [{ ...firstList, bodyLines: [firstList.text] }];
      i++;
      while (i < lines.length) {
        const cur = lines[i];
        if (!cur.trim()) {
          // Peek next non-blank line; continue same list if it's also a list item.
          if (i + 1 < lines.length && matchListLine(lines[i + 1])) {
            i++;
            continue;
          }
          break;
        }
        const nextList = matchListLine(cur);
        if (nextList) {
          items.push({ ...nextList, bodyLines: [nextList.text] });
          i++;
          continue;
        }
        // Indented continuation line inside the current item
        if (/^\s{2,}\S/.test(cur) && !matchFenceOpen(cur)) {
          items[items.length - 1].bodyLines.push(cur.trim());
          i++;
          continue;
        }
        break;
      }
      blocks.push(renderListBlock(items));
      continue;
    }

    // Paragraph: stops cleanly at any block opener
    const paraLines = [];
    while (i < lines.length) {
      const cur = lines[i];
      if (!cur.trim()) break;
      if (matchFenceOpen(cur) || isHeadingLine(cur) || isHrLine(cur) || /^\s{0,3}>\s?/.test(cur) || matchListLine(cur)) {
        break;
      }
      if (cur.includes("|") && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1])) {
        break;
      }
      paraLines.push(cur);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push(`<p>${paraLines.map((l) => renderInline(l)).join("<br />")}</p>`);
    } else {
      i++;
    }
  }

  return `<div class="md-body">${blocks.join("\n")}</div>`;
}

// Compute line-level diff operations and stats with bounded LCS fallback for very large files.
function computeLineDiffOps(oldText, newText) {
  const aLines = String(oldText ?? "").replace(/\r\n?/g, "\n").split("\n");
  const bLines = String(newText ?? "").replace(/\r\n?/g, "\n").split("\n");

  if (oldText === "" && newText === "") return [];
  const aArr = oldText === "" ? [] : aLines;
  const bArr = newText === "" ? [] : bLines;

  let prefix = 0;
  while (prefix < aArr.length && prefix < bArr.length && aArr[prefix] === bArr[prefix]) {
    prefix++;
  }
  let aEnd = aArr.length - 1;
  let bEnd = bArr.length - 1;
  while (aEnd >= prefix && bEnd >= prefix && aArr[aEnd] === bArr[bEnd]) {
    aEnd--;
    bEnd--;
  }

  const ops = [];
  for (let i = 0; i < prefix; i++) {
    ops.push({ type: "ctx", oldLine: i + 1, newLine: i + 1, text: aArr[i] });
  }

  const aMid = aArr.slice(prefix, aEnd + 1);
  const bMid = bArr.slice(prefix, bEnd + 1);
  const m = aMid.length;
  const n = bMid.length;

  if (m === 0 && n === 0) {
    // identical
  } else if (m * n <= 160000) {
    const cols = n + 1;
    const dp = new Uint32Array((m + 1) * cols);
    for (let i = m - 1; i >= 0; i--) {
      const rowOff = i * cols;
      const nextOff = (i + 1) * cols;
      for (let j = n - 1; j >= 0; j--) {
        if (aMid[i] === bMid[j]) {
          dp[rowOff + j] = dp[nextOff + j + 1] + 1;
        } else {
          const down = dp[nextOff + j];
          const right = dp[rowOff + j + 1];
          dp[rowOff + j] = down >= right ? down : right;
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (aMid[i] === bMid[j]) {
        ops.push({
          type: "ctx",
          oldLine: prefix + i + 1,
          newLine: prefix + j + 1,
          text: aMid[i],
        });
        i++;
        j++;
      } else if (dp[(i + 1) * cols + j] >= dp[i * cols + j + 1]) {
        ops.push({ type: "del", oldLine: prefix + i + 1, newLine: null, text: aMid[i] });
        i++;
      } else {
        ops.push({ type: "add", oldLine: null, newLine: prefix + j + 1, text: bMid[j] });
        j++;
      }
    }
    while (i < m) {
      ops.push({ type: "del", oldLine: prefix + i + 1, newLine: null, text: aMid[i] });
      i++;
    }
    while (j < n) {
      ops.push({ type: "add", oldLine: null, newLine: prefix + j + 1, text: bMid[j] });
      j++;
    }
  } else {
    for (let i = 0; i < m; i++) {
      ops.push({ type: "del", oldLine: prefix + i + 1, newLine: null, text: aMid[i] });
    }
    for (let j = 0; j < n; j++) {
      ops.push({ type: "add", oldLine: null, newLine: prefix + j + 1, text: bMid[j] });
    }
  }

  for (let k = aEnd + 1; k < aArr.length; k++) {
    const newIdx = bEnd + 1 + (k - (aEnd + 1));
    ops.push({ type: "ctx", oldLine: k + 1, newLine: newIdx + 1, text: aArr[k] });
  }
  return ops;
}

export function computeDiffStats(oldText, newText) {
  const ops = computeLineDiffOps(oldText, newText);
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === "add") added++;
    else if (op.type === "del") removed++;
  }
  return { added, removed };
}

export function renderUnifiedDiff(oldText, newText, filePath) {
  const ops = computeLineDiffOps(oldText, newText);
  if (ops.length === 0) {
    return `<div class="diff-view"><div class="diff-empty">无文本变更</div></div>`;
  }

  const CONTEXT = 3;
  const keep = new Uint8Array(ops.length);
  let hasChanges = false;
  for (let idx = 0; idx < ops.length; idx++) {
    if (ops[idx].type !== "ctx") {
      hasChanges = true;
      const start = Math.max(0, idx - CONTEXT);
      const end = Math.min(ops.length - 1, idx + CONTEXT);
      for (let k = start; k <= end; k++) keep[k] = 1;
    }
  }

  if (!hasChanges) {
    return `<div class="diff-view">${filePath ? `<div class="diff-file-head">${escapeHtml(filePath)}</div>` : ""}<div class="diff-empty">文件内容一致（无变更）</div></div>`;
  }

  let rowsHtml = "";
  let idx = 0;
  while (idx < ops.length) {
    if (!keep[idx]) {
      let skipped = 0;
      while (idx < ops.length && !keep[idx]) {
        skipped++;
        idx++;
      }
      rowsHtml += `<tr class="diff-row-fold"><td class="diff-ln" colspan="2">⋯</td><td class="diff-sign"></td><td class="diff-code">省略 ${skipped} 行未修改内容</td></tr>`;
      continue;
    }
    const op = ops[idx];
    const rowCls =
      op.type === "add" ? "diff-row-add" : op.type === "del" ? "diff-row-del" : "diff-row-ctx";
    const sign = op.type === "add" ? "+" : op.type === "del" ? "-" : " ";
    const lnOld = op.oldLine !== null ? String(op.oldLine) : "";
    const lnNew = op.newLine !== null ? String(op.newLine) : "";
    rowsHtml += `<tr class="${rowCls}"><td class="diff-ln">${lnOld}</td><td class="diff-ln">${lnNew}</td><td class="diff-sign">${sign}</td><td class="diff-code"><code>${escapeHtml(op.text)}</code></td></tr>`;
    idx++;
  }

  const headerHtml = filePath ? `<div class="diff-file-head">${escapeHtml(filePath)}</div>` : "";
  return `<div class="diff-view">${headerHtml}<table class="diff-table"><tbody>${rowsHtml}</tbody></table></div>`;
}

// Identify failed assistant messages and fold consecutive non-trailing retry attempts.
export function isFailedAssistantMsg(m) {
  if (!m || m.role !== "assistant") return false;
  if (m.status === "error") return true;
  return /^\s*\[Error\]/i.test(String(m.text || ""));
}

export function isPureErrorAssistantMsg(m) {
  if (!isFailedAssistantMsg(m)) return false;
  const hasTools = Array.isArray(m.toolCalls) && m.toolCalls.length > 0;
  if (hasTools) return false;
  const trimmed = String(m.text || "").trim();
  if (!trimmed) return true;
  if (/^\s*\[Error\]/i.test(trimmed)) return true;
  return m.status === "error" && trimmed.length < 400;
}

function isUserPromptMsg(m) {
  return Boolean(m && (m.role === "user" || m.role === "caller"));
}

function normalizePromptSignature(m) {
  const text = String(m?.text || "").replace(/\s+/g, " ").trim();
  const imgCount = Array.isArray(m?.images) ? m.images.length : 0;
  const fileCount = Array.isArray(m?.files) ? m.files.length : 0;
  return `${text}::img=${imgCount}::file=${fileCount}`;
}

export function summarizeRetryErrorText(rawText) {
  const singleLine = String(rawText || "")
    .replace(/^\s*\[Error\]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!singleLine) return "会话执行失败";
  return singleLine.length > 96 ? `${singleLine.slice(0, 93)}...` : singleLine;
}

export function partitionMessagesForDisplay(list) {
  if (!Array.isArray(list) || list.length === 0) return [];

  // Step 1: collect atomic items: either a normal message or a foldable unit.
  const units = [];
  let i = 0;

  while (i < list.length) {
    const cur = list[i];

    // Case A: [user/caller] followed by >=1 failed assistant messages, followed by ANOTHER [user/caller]
    if (isUserPromptMsg(cur) && i + 1 < list.length && isFailedAssistantMsg(list[i + 1])) {
      let j = i + 1;
      while (j < list.length && isFailedAssistantMsg(list[j])) {
        j++;
      }
      const failedSlice = list.slice(i + 1, j);
      const nextMsg = j < list.length ? list[j] : null;
      const followedByUser = isUserPromptMsg(nextMsg);
      const allPureErrors = failedSlice.every((m) => isPureErrorAssistantMsg(m));
      const samePrompt = followedByUser && normalizePromptSignature(cur) === normalizePromptSignature(nextMsg);

      if (followedByUser && (allPureErrors || samePrompt)) {
        units.push({
          foldable: true,
          attempts: failedSlice.length,
          messages: list.slice(i, j),
          failedMessages: failedSlice,
        });
        i = j;
        continue;
      }
    }

    // Case B: standalone failed assistant message(s) that are NOT trailing at the very end of the stream.
    if (isFailedAssistantMsg(cur)) {
      let j = i + 1;
      while (j < list.length && isFailedAssistantMsg(list[j])) {
        j++;
      }
      // Keep the very last failed message visible if it's trailing at stream end.
      const foldEnd = j === list.length ? j - 1 : j;
      if (foldEnd > i) {
        const failedSlice = list.slice(i, foldEnd);
        units.push({
          foldable: true,
          attempts: failedSlice.length,
          messages: failedSlice,
          failedMessages: failedSlice,
        });
        i = foldEnd;
        continue;
      }
      // Trailing single error remains visible
      units.push({ foldable: false, message: cur, index: i });
      i++;
      continue;
    }

    units.push({ foldable: false, message: cur, index: i });
    i++;
  }

  // Step 2: merge adjacent foldable units into a single compact retry-fold entry.
  const result = [];
  let pendingFold = null;

  const flushFold = () => {
    if (!pendingFold) return;
    const lastFailed = pendingFold.failedMessages[pendingFold.failedMessages.length - 1];
    const agentSet = new Set();
    for (const fm of pendingFold.failedMessages) {
      if (fm.agent) agentSet.add(fm.agent);
      else if (fm.senderLabel) agentSet.add(fm.senderLabel);
    }
    const firstId = pendingFold.messages[0]?.messageId || String(pendingFold.startIndex);
    result.push({
      kind: "retry-fold",
      key: `retry-${firstId}`,
      attempts: pendingFold.attempts,
      agents: [...agentSet],
      lastErrorSummary: summarizeRetryErrorText(lastFailed?.text || ""),
      messages: pendingFold.messages,
    });
    pendingFold = null;
  };

  for (const unit of units) {
    if (unit.foldable) {
      if (!pendingFold) {
        pendingFold = {
          attempts: unit.attempts,
          messages: [...unit.messages],
          failedMessages: [...unit.failedMessages],
          startIndex: result.length,
        };
      } else {
        pendingFold.attempts += unit.attempts;
        pendingFold.messages.push(...unit.messages);
        pendingFold.failedMessages.push(...unit.failedMessages);
      }
    } else {
      flushFold();
      result.push({ kind: "message", message: unit.message, index: unit.index });
    }
  }
  flushFold();

  return result;
}
