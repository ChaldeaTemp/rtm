import type { AgentId, TaskRecord, WorkflowRecord, WorkflowStep, WorkflowStepInput } from "../types.js";

const MAX_STEPS = 20;
const STEP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export interface WorkflowDeps {
  /** Starts a sub-session task for a step and returns its task record. */
  dispatch(input: {
    groupId: string;
    agent: AgentId;
    prompt: string;
    session: string;
    isolateWorktree: boolean;
    /** Context sections the step asked for, and the steps whose results it builds on. */
    contextRefs: string[];
    upstreamStepIds: string[];
  }): TaskRecord;
  /** Sections a step refers to that do not exist; publishing is refused while there are any. */
  missingContext(groupId: string, keys: string[]): string[];
  /** A step finished: keep its output where later steps can get it. */
  saveResult(groupId: string, step: WorkflowStep, output: string): void;
  /** A new run begins: results of the previous one no longer apply. */
  clearResults(groupId: string): void;
  /** Stops whatever is running in a sub-session. */
  cancel(sessionKey: string): void;
  isKnownAgent(agent: string): boolean;
  /** Called after every change so the hub can broadcast it. */
  onChange(workflow: WorkflowRecord): void;
}

/**
 * One workflow per task group: a small DAG of sub-session steps that the user (or the lead
 * agent, through the `workflow_propose` MCP tool) drafts first and publishes afterwards.
 * Publishing dispatches every step whose dependencies are done; a step's prompt gets the
 * output of the steps it depends on appended.
 */
export class WorkflowManager {
  private readonly workflows = new Map<string, WorkflowRecord>();

  constructor(private readonly deps: WorkflowDeps) {}

  get(groupId: string): WorkflowRecord {
    return (
      this.clone(this.workflows.get(groupId)) ?? {
        groupId,
        status: "draft",
        steps: [],
        updatedAt: 0,
      }
    );
  }

  list(): WorkflowRecord[] {
    return [...this.workflows.values()].map((w) => this.clone(w)!);
  }

  /** Replaces the draft. Refused while the workflow is running. */
  save(groupId: string, rawSteps: WorkflowStepInput[], proposedBy: AgentId | "user"): WorkflowRecord {
    const current = this.workflows.get(groupId);
    if (current?.status === "running") {
      throw new Error("工作流正在运行，先停止或等它结束再修改");
    }
    if (rawSteps.length > MAX_STEPS) {
      throw new Error(`一个工作流最多 ${MAX_STEPS} 步`);
    }

    const steps: WorkflowStep[] = [];
    const seen = new Set<string>();
    rawSteps.forEach((raw, index) => {
      const id = (raw.id ?? "").trim().toLowerCase() || `step${index + 1}`;
      if (!STEP_ID_RE.test(id)) {
        throw new Error(`步骤 ID「${raw.id}」只能用小写字母、数字、- 和 _`);
      }
      if (seen.has(id)) {
        throw new Error(`步骤 ID「${id}」重复`);
      }
      seen.add(id);
      const agent = (raw.agent ?? "").trim().toLowerCase();
      if (!this.deps.isKnownAgent(agent)) {
        throw new Error(`步骤「${id}」的 Agent「${raw.agent}」不存在`);
      }
      // A draft may still have empty steps; run() is where a missing task is refused.
      const prompt = (raw.prompt ?? "").trim();
      steps.push({
        id,
        name: (raw.name ?? "").trim() || id,
        agent,
        prompt,
        dependsOn: [...new Set((raw.dependsOn ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean))],
        contextRefs: [...new Set((raw.contextRefs ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean))],
        isolateWorktree: Boolean(raw.isolateWorktree),
        status: "draft",
      });
    });

    for (const step of steps) {
      for (const dep of step.dependsOn) {
        if (dep === step.id || !seen.has(dep)) {
          throw new Error(`步骤「${step.id}」依赖的「${dep}」不存在`);
        }
      }
    }
    this.assertAcyclic(steps);

    const workflow: WorkflowRecord = { groupId, status: "draft", steps, proposedBy, updatedAt: Date.now() };
    this.workflows.set(groupId, workflow);
    this.deps.onChange(this.clone(workflow)!);
    return this.clone(workflow)!;
  }

  /** Publishes the draft: every step becomes pending and the ready ones are dispatched. */
  run(groupId: string): WorkflowRecord {
    const workflow = this.workflows.get(groupId);
    if (!workflow || workflow.steps.length === 0) {
      throw new Error("工作流还没有步骤");
    }
    if (workflow.status === "running") {
      throw new Error("工作流已经在运行");
    }
    const empty = workflow.steps.filter((s) => !s.prompt.trim());
    if (empty.length > 0) {
      throw new Error(`这些步骤还没有写任务内容：${empty.map((s) => s.name).join("、")}`);
    }
    const missing = new Set<string>();
    for (const step of workflow.steps) {
      for (const key of this.deps.missingContext(groupId, step.contextRefs ?? [])) missing.add(key);
    }
    if (missing.size > 0) {
      throw new Error(`这些步骤引用的上下文分区不存在：${[...missing].join("、")}`);
    }
    this.deps.clearResults(groupId);
    for (const step of workflow.steps) {
      step.status = "pending";
      step.taskId = undefined;
      step.sessionKey = undefined;
      step.error = undefined;
      step.output = undefined;
    }
    workflow.status = "running";
    this.advance(workflow);
    return this.clone(workflow)!;
  }

  /** Stops running steps and drops the ones that have not started. */
  cancel(groupId: string): WorkflowRecord {
    const workflow = this.workflows.get(groupId);
    if (!workflow || workflow.status !== "running") {
      return this.get(groupId);
    }
    for (const step of workflow.steps) {
      if (step.status === "pending") {
        step.status = "cancelled";
      } else if (step.status === "running" && step.sessionKey) {
        this.deps.cancel(step.sessionKey);
      }
    }
    this.advance(workflow);
    return this.clone(workflow)!;
  }

  /** Feeds a sub-session task result back into the workflow that started it. */
  onTaskUpdated(task: TaskRecord): void {
    const workflow = this.workflows.get(task.groupId);
    if (!workflow || workflow.status !== "running") {
      return;
    }
    const step = workflow.steps.find((s) => s.taskId === task.taskId);
    if (!step || step.status !== "running") {
      return;
    }
    if (task.status === "completed") {
      step.status = "completed";
      step.output = task.outputText;
      this.deps.saveResult(workflow.groupId, step, task.outputText);
    } else if (task.status === "failed") {
      step.status = "failed";
      step.error = task.error;
    } else if (task.status === "cancelled") {
      step.status = "cancelled";
    } else {
      return;
    }
    this.advance(workflow);
  }

  forget(groupId: string): void {
    if (this.workflows.delete(groupId)) {
      this.deps.onChange({ groupId, status: "draft", steps: [], updatedAt: Date.now() });
    }
  }

  /**
   * Loads workflows saved before a restart. Nothing is running any more, so a workflow that
   * was mid-run is closed as failed and its unfinished steps as cancelled.
   */
  restore(records: WorkflowRecord[]): void {
    for (const record of records) {
      const workflow = this.clone(record)!;
      if (workflow.status === "running") {
        for (const step of workflow.steps) {
          if (step.status === "running" || step.status === "pending") {
            step.status = "cancelled";
            step.error = "hub 重启时中断";
          }
        }
        workflow.status = "failed";
      }
      this.workflows.set(workflow.groupId, workflow);
    }
  }

  private advance(workflow: WorkflowRecord): void {
    const byId = new Map(workflow.steps.map((s) => [s.id, s]));
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const step of workflow.steps) {
        if (step.status !== "pending") continue;
        const deps = step.dependsOn.map((id) => byId.get(id)!);
        if (deps.some((d) => d.status === "failed" || d.status === "cancelled" || d.status === "skipped")) {
          step.status = "skipped";
          progressed = true;
          continue;
        }
        if (!deps.every((d) => d.status === "completed")) continue;
        try {
          const task = this.deps.dispatch({
            groupId: workflow.groupId,
            agent: step.agent,
            // Background and upstream results travel as context, not inside the step prompt.
            prompt: step.prompt,
            session: `wf-${step.id}`,
            isolateWorktree: Boolean(step.isolateWorktree),
            contextRefs: step.contextRefs ?? [],
            upstreamStepIds: deps.map((d) => d.id),
          });
          step.status = "running";
          step.taskId = task.taskId;
          step.sessionKey = task.targetSessionKey;
        } catch (err) {
          step.status = "failed";
          step.error = err instanceof Error ? err.message : String(err);
        }
        progressed = true;
      }
    }

    const active = workflow.steps.some((s) => s.status === "pending" || s.status === "running");
    if (!active) {
      workflow.status = workflow.steps.every((s) => s.status === "completed") ? "completed" : "failed";
    }
    workflow.updatedAt = Date.now();
    this.deps.onChange(this.clone(workflow)!);
  }

  private assertAcyclic(steps: WorkflowStep[]): void {
    const remaining = new Map(steps.map((s) => [s.id, new Set(s.dependsOn)]));
    while (remaining.size > 0) {
      const ready = [...remaining.entries()].filter(([, deps]) => deps.size === 0).map(([id]) => id);
      if (ready.length === 0) {
        throw new Error(`步骤之间存在循环依赖：${[...remaining.keys()].join("、")}`);
      }
      for (const id of ready) {
        remaining.delete(id);
        for (const deps of remaining.values()) deps.delete(id);
      }
    }
  }

  private clone(workflow: WorkflowRecord | undefined): WorkflowRecord | undefined {
    return workflow
      ? {
          ...workflow,
          steps: workflow.steps.map((s) => ({
            ...s,
            dependsOn: [...s.dependsOn],
            contextRefs: [...(s.contextRefs ?? [])],
          })),
        }
      : undefined;
  }
}
