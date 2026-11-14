import { t } from "./i18n.js";
import type { AgentId, TaskContext, TaskContextSection } from "../types.js";

/** The section every sub-session of a task receives. */
export const COMMON_SECTION_KEY = "common";
const RESULT_PREFIX = "result:";
const SECTION_KEY_RE = /^[a-z0-9][a-z0-9_.:-]{0,47}$/;

const MAX_COMMON_CHARS = 4000;
const MAX_SECTION_CHARS = 8000;
const MAX_RESULT_CHARS = 6000;
const MAX_SECTIONS = 40;

function clipMiddle(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) {
    return t;
  }
  const head = Math.ceil(max * 0.6);
  return `${t.slice(0, head)}\n... [truncated] ...\n${t.slice(-(max - head))}`;
}

export function resultSectionKey(stepId: string): string {
  return `${RESULT_PREFIX}${stepId}`;
}

/**
 * Shared context of a task, split into sections, so that background is written once instead
 * of being repeated in every sub-session prompt:
 *
 * - `common`: what every step needs to know.
 * - named sections: material that only some steps need; a step lists the ones it uses.
 * - `result:<step>`: a finished workflow step's output, stored automatically.
 *
 * A sub-session is handed the smallest useful set (common + its own sections + the results
 * it depends on) plus an index of the rest, which it can read on demand.
 */
export class TaskContextStore {
  private readonly byGroup = new Map<string, Map<string, TaskContextSection>>();

  constructor(private readonly onChange: (context: TaskContext) => void) {}

  get(groupId: string): TaskContext {
    const sections = [...(this.byGroup.get(groupId)?.values() ?? [])].map((s) => ({ ...s }));
    const rank = (s: TaskContextSection) => (s.kind === "common" ? 0 : s.kind === "section" ? 1 : 2);
    sections.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
    return { groupId, sections };
  }

  list(): TaskContext[] {
    return [...this.byGroup.keys()].map((groupId) => this.get(groupId));
  }

  getSection(groupId: string, key: string): TaskContextSection | undefined {
    const section = this.byGroup.get(groupId)?.get(key.trim().toLowerCase());
    return section ? { ...section } : undefined;
  }

  /** Creates or replaces one section. Empty content removes it. */
  put(
    groupId: string,
    input: { key: string; content: string; summary?: string; updatedBy?: AgentId | "user" },
  ): TaskContext {
    const key = input.key.trim().toLowerCase();
    if (!SECTION_KEY_RE.test(key)) {
      throw new Error(t("sectionKeyMustBeAtMost48", input.key));
    }
    if (key.startsWith(RESULT_PREFIX)) {
      throw new Error(t("keysStartingWithResultAreReservedFor"));
    }
    const sections = this.ensure(groupId);
    const content = input.content.trim();
    if (!content) {
      sections.delete(key);
    } else {
      if (!sections.has(key) && sections.size >= MAX_SECTIONS) {
        throw new Error(t("aTaskCanContainUpToSections", MAX_SECTIONS));
      }
      const isCommon = key === COMMON_SECTION_KEY;
      sections.set(key, {
        key,
        kind: isCommon ? "common" : "section",
        summary: input.summary?.trim().slice(0, 160) || undefined,
        content: clipMiddle(content, isCommon ? MAX_COMMON_CHARS : MAX_SECTION_CHARS),
        truncated: content.length > (isCommon ? MAX_COMMON_CHARS : MAX_SECTION_CHARS) || undefined,
        updatedBy: input.updatedBy ?? "user",
        updatedAt: Date.now(),
      });
    }
    return this.changed(groupId);
  }

  /**
   * Replaces the hand-written part (common + named sections) in one go, as the workflow
   * editor and `workflow_propose` do. Step results are left alone.
   */
  replaceAuthored(
    groupId: string,
    input: {
      common?: string;
      sections?: Array<{ key: string; content: string; summary?: string }>;
      updatedBy?: AgentId | "user";
    },
  ): TaskContext {
    const sections = this.ensure(groupId);
    const results = [...sections.values()].filter((s) => s.kind === "result");
    const snapshot = new Map(sections);
    sections.clear();
    for (const r of results) sections.set(r.key, r);
    try {
      if (input.common?.trim()) {
        this.put(groupId, { key: COMMON_SECTION_KEY, content: input.common, updatedBy: input.updatedBy });
      }
      for (const s of input.sections ?? []) {
        if (s.key.trim().toLowerCase() === COMMON_SECTION_KEY) continue;
        this.put(groupId, { ...s, updatedBy: input.updatedBy });
      }
    } catch (err) {
      // All or nothing: a bad section must not wipe the ones that were there.
      sections.clear();
      for (const [k, v] of snapshot) sections.set(k, v);
      throw err;
    }
    return this.changed(groupId);
  }

  /** Stores a finished step's output so later steps (and the lead) can read it. */
  setResult(groupId: string, step: { id: string; name: string; agent: AgentId }, output: string): void {
    if (!output.trim()) return;
    this.ensure(groupId).set(resultSectionKey(step.id), {
      key: resultSectionKey(step.id),
      kind: "result",
      summary: `「${step.name}」的结果（${step.agent}）`,
      content: clipMiddle(output, MAX_RESULT_CHARS),
      truncated: output.trim().length > MAX_RESULT_CHARS || undefined,
      updatedBy: step.agent,
      updatedAt: Date.now(),
    });
    this.changed(groupId);
  }

  /** Step results belong to one run; a new run starts without the previous ones. */
  clearResults(groupId: string): void {
    const sections = this.byGroup.get(groupId);
    if (!sections) return;
    let removed = false;
    for (const [key, s] of sections) {
      if (s.kind === "result") {
        sections.delete(key);
        removed = true;
      }
    }
    if (removed) this.changed(groupId);
  }

  missingSections(groupId: string, keys: string[]): string[] {
    const sections = this.byGroup.get(groupId);
    return keys.filter((k) => !sections?.has(k.trim().toLowerCase()));
  }

  /**
   * The context block put in front of a sub-session's prompt: common, the sections it asked
   * for, the results it depends on, and an index of everything else. Empty when the task has
   * no shared context at all.
   */
  buildPrefix(groupId: string, want: { sections?: string[]; results?: string[] } = {}): string {
    const all = this.byGroup.get(groupId);
    if (!all || all.size === 0) {
      return "";
    }
    const included = new Set<string>();
    const parts: string[] = [];

    const common = all.get(COMMON_SECTION_KEY);
    if (common) {
      included.add(common.key);
      parts.push(`## Shared background (applies to every step of this task)\n${common.content}`);
    }
    for (const raw of want.sections ?? []) {
      const s = all.get(raw.trim().toLowerCase());
      if (!s || included.has(s.key)) continue;
      included.add(s.key);
      parts.push(`## Section "${s.key}"${s.summary ? ` (${s.summary})` : ""}\n${s.content}`);
    }
    for (const stepId of want.results ?? []) {
      const s = all.get(resultSectionKey(stepId));
      if (!s || included.has(s.key)) continue;
      included.add(s.key);
      parts.push(`## Result of an earlier step: ${s.summary ?? stepId}\n${s.content}`);
    }
    const rest = [...all.values()].filter((s) => !included.has(s.key));
    if (rest.length > 0) {
      parts.push(
        [
          "## Other sections of this task (not included; read one with the `context_get` tool only if you need it)",
          ...rest.map((s) => `- ${s.key}${s.summary ? `: ${s.summary}` : ""}`),
        ].join("\n"),
      );
    }
    if (parts.length === 0) {
      return "";
    }
    return `<task_context>\n${parts.join("\n\n")}\n</task_context>\n\n`;
  }

  forget(groupId: string): void {
    this.byGroup.delete(groupId);
  }

  restore(contexts: TaskContext[]): void {
    for (const context of contexts) {
      const sections = this.ensure(context.groupId);
      for (const s of context.sections ?? []) {
        if (s?.key && typeof s.content === "string") sections.set(s.key, { ...s });
      }
    }
  }

  private ensure(groupId: string): Map<string, TaskContextSection> {
    let sections = this.byGroup.get(groupId);
    if (!sections) {
      sections = new Map();
      this.byGroup.set(groupId, sections);
    }
    return sections;
  }

  private changed(groupId: string): TaskContext {
    const context = this.get(groupId);
    this.onChange(context);
    return context;
  }
}
