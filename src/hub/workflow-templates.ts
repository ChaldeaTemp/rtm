import fs from "node:fs";
import path from "node:path";
import type { WorkflowStep, WorkflowStepInput } from "../types.js";

/** A saved arrangement of workflow steps that can be loaded into any task as a draft. */
export interface WorkflowTemplate {
  name: string;
  steps: WorkflowStepInput[];
  updatedAt: number;
}

export interface WorkflowTemplateSummary {
  name: string;
  stepCount: number;
  agents: string[];
  updatedAt: number;
}

const MAX_TEMPLATES = 50;

/** Keeps what defines a step and drops everything that belongs to one particular run. */
export function stepToTemplate(step: WorkflowStep): WorkflowStepInput {
  return {
    id: step.id,
    name: step.name,
    agent: step.agent,
    prompt: step.prompt,
    dependsOn: [...step.dependsOn],
    isolateWorktree: Boolean(step.isolateWorktree),
    // Context sections belong to the task the template came from, not to the template.
    contextRefs: [],
    review: step.review ? { ...step.review } : undefined,
  };
}

export class WorkflowTemplateStore {
  constructor(private readonly file: string) {}

  private load(): WorkflowTemplate[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
      return Array.isArray(parsed)
        ? (parsed as WorkflowTemplate[]).filter((t) => t && typeof t.name === "string" && Array.isArray(t.steps))
        : [];
    } catch {
      return [];
    }
  }

  private store(templates: WorkflowTemplate[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(templates, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }

  list(): WorkflowTemplateSummary[] {
    return this.load()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((t) => ({
        name: t.name,
        stepCount: t.steps.length,
        agents: [...new Set(t.steps.map((s) => s.agent))],
        updatedAt: t.updatedAt,
      }));
  }

  get(name: string): WorkflowTemplate | undefined {
    return this.load().find((t) => t.name === name.trim());
  }

  /** Saves under `name`, replacing a template of the same name. */
  save(name: string, steps: WorkflowStep[]): WorkflowTemplateSummary[] {
    const clean = name.trim().slice(0, 60);
    if (!clean) throw new Error("模板需要一个名称");
    if (steps.length === 0) throw new Error("工作流还没有步骤，没有可保存的内容");
    const rest = this.load().filter((t) => t.name !== clean);
    if (rest.length >= MAX_TEMPLATES) throw new Error(`最多保存 ${MAX_TEMPLATES} 个模板，先删掉不用的`);
    this.store([...rest, { name: clean, steps: steps.map(stepToTemplate), updatedAt: Date.now() }]);
    return this.list();
  }

  delete(name: string): WorkflowTemplateSummary[] {
    this.store(this.load().filter((t) => t.name !== name.trim()));
    return this.list();
  }
}
