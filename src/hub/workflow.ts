import { t } from "./i18n.js";
import type { AgentId, TaskRecord, WorkflowRecord, WorkflowStep, WorkflowStepInput } from "../types.js";

const MAX_STEPS = 20;
const DEFAULT_REVIEW_ROUNDS = 2;

/**
 * Appended to what a step's agent is asked to do. Finishing a turn is not the same as
 * finishing the task: without this an agent that gave up still counted as a completed step
 * and the steps after it ran on nothing.
 */
const STATUS_INSTRUCTION = [
  "",
  "",
  "End your reply with exactly one status line:",
  "`STATUS: DONE` if the task is finished and you checked it;",
  "`STATUS: BLOCKED - <what you need>` if you cannot go on without something;",
  "`STATUS: FAILED - <why>` if you could not do it.",
  "Never write DONE for work you did not complete.",
].join("\n");

/** The outcome an agent declared at the end of its reply; no line counts as done. */
export function parseStepOutcome(output: string): { ok: boolean; reason?: string } {
  const matches = [...(output ?? "").matchAll(/STATUS:\s*\**\s*(DONE|BLOCKED|FAILED)\b\**[ \t]*[-:：—]*[ \t]*([^\n]*)/gi)];
  const last = matches[matches.length - 1];
  if (!last) return { ok: true };
  const word = last[1]!.toUpperCase();
  if (word === "DONE") return { ok: true };
  const detail = last[2]?.trim().replace(/[`*]+$/g, "").trim();
  return { ok: false, reason: `${word === "BLOCKED" ? "BLOCKED" : "FAILED"}${detail ? `: ${detail}` : ""}` };
}
const MAX_REVIEW_ROUNDS = 5;
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
  /** A run ended (every step finished, or nothing more can run). Not called for a user stop. */
  onSettled?(workflow: WorkflowRecord): void;
  /** How many steps may run at once; the rest wait even when their dependencies are done. */
  maxParallel?(): number;
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

  /** Runs the user stopped; their end is not reported to the lead as a failure to act on. */
  private readonly userStopped = new Set<string>();

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
      throw new Error(t("stopTheWorkflowOrWaitForIt"));
    }
    if (rawSteps.length > MAX_STEPS) {
      throw new Error(t("aWorkflowCanContainUpToSteps", MAX_STEPS));
    }

    const steps: WorkflowStep[] = [];
    const seen = new Set<string>();
    rawSteps.forEach((raw, index) => {
      const id = (raw.id ?? "").trim().toLowerCase() || `step${index + 1}`;
      if (!STEP_ID_RE.test(id)) {
        throw new Error(t("stepIdCanOnlyContainLowercaseLetters", raw.id));
      }
      if (seen.has(id)) {
        throw new Error(t("duplicateStepId", id));
      }
      seen.add(id);
      const agent = (raw.agent ?? "").trim().toLowerCase();
      if (!this.deps.isKnownAgent(agent)) {
        throw new Error(t("agentForStepDoesNotExist", id, raw.agent));
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
        review: this.normalizeReview(id, raw.review),
        status: "draft",
      });
    });

    for (const step of steps) {
      for (const dep of step.dependsOn) {
        if (dep === step.id || !seen.has(dep)) {
          throw new Error(t("stepDependsOnMissingStep", step.id, dep));
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
      throw new Error(t("thisWorkflowHasNoStepsYet"));
    }
    if (workflow.status === "running") {
      throw new Error(t("theWorkflowIsAlreadyRunning"));
    }
    const empty = workflow.steps.filter((s) => !s.prompt.trim());
    if (empty.length > 0) {
      throw new Error(t("stepsWithoutInstructions", empty.map((s) => s.name).join("、")));
    }
    const missing = new Set<string>();
    for (const step of workflow.steps) {
      for (const key of this.deps.missingContext(groupId, step.contextRefs ?? [])) missing.add(key);
    }
    if (missing.size > 0) {
      throw new Error(t("referencedContextSectionsDoNotExist", [...missing].join("、")));
    }
    this.deps.clearResults(groupId);
    for (const step of workflow.steps) {
      step.status = "pending";
      step.taskId = undefined;
      step.sessionKey = undefined;
      step.error = undefined;
      step.errorKind = undefined;
      step.output = undefined;
      step.phase = undefined;
      step.round = undefined;
      step.reviewNotes = undefined;
      step.reviewSessionKey = undefined;
    }
    workflow.status = "running";
    this.advance(workflow);
    return this.clone(workflow)!;
  }

  /**
   * Re-runs incomplete steps while keeping already-completed steps and their saved results intact.
   */
  retryFailed(groupId: string): WorkflowRecord {
    const workflow = this.workflows.get(groupId);
    if (!workflow || workflow.steps.length === 0) {
      throw new Error(t("thisWorkflowHasNoStepsYet"));
    }
    if (workflow.status === "running") {
      throw new Error(t("stopTheWorkflowOrWaitForThe"));
    }
    const incomplete = workflow.steps.filter((s) => s.status !== "completed");
    if (incomplete.length === 0) {
      throw new Error(t("allStepsAreCompleteThereIsNothing"));
    }
    const empty = incomplete.filter((s) => !s.prompt.trim());
    if (empty.length > 0) {
      throw new Error(t("stepsWithoutInstructions", empty.map((s) => s.name).join("、")));
    }
    const missing = new Set<string>();
    for (const step of incomplete) {
      for (const key of this.deps.missingContext(groupId, step.contextRefs ?? [])) missing.add(key);
    }
    if (missing.size > 0) {
      throw new Error(t("referencedContextSectionsDoNotExist", [...missing].join("、")));
    }
    for (const step of workflow.steps) {
      if (step.status === "completed") {
        if (step.output?.trim()) {
          this.deps.saveResult(groupId, step, step.output);
        }
        continue;
      }
      step.status = "pending";
      step.taskId = undefined;
      step.sessionKey = undefined;
      step.error = undefined;
      step.errorKind = undefined;
      step.output = undefined;
      step.phase = undefined;
      step.round = undefined;
      step.reviewNotes = undefined;
      step.reviewSessionKey = undefined;
    }
    workflow.status = "running";
    this.advance(workflow);
    return this.clone(workflow)!;
  }

  /**
   * Continues a workflow that stopped part-way (a failed step, a stop, a hub restart): finished
   * steps and their results are kept, everything else is queued again.
   */
  resume(groupId: string): WorkflowRecord {
    const workflow = this.workflows.get(groupId);
    if (!workflow || workflow.steps.length === 0) {
      throw new Error(t("thisWorkflowHasNoStepsYet"));
    }
    if (workflow.status === "running") {
      throw new Error(t("theWorkflowIsAlreadyRunning"));
    }
    const unfinished = workflow.steps.filter((s) => s.status !== "completed");
    if (workflow.status === "draft" || unfinished.length === 0) {
      throw new Error(t("thereAreNoStepsToResume"));
    }
    for (const step of workflow.steps) {
      if (step.status === "completed") {
        if (step.output?.trim()) {
          this.deps.saveResult(groupId, step, step.output);
        }
        continue;
      }
      step.status = "pending";
      step.taskId = undefined;
      step.sessionKey = undefined;
      step.error = undefined;
      step.errorKind = undefined;
      step.output = undefined;
      step.phase = undefined;
      step.round = undefined;
      step.reviewNotes = undefined;
      step.reviewSessionKey = undefined;
    }
    workflow.status = "running";
    this.advance(workflow);
    return this.clone(workflow)!;
  }

  /**
   * The lead's decision after a failure: retry the failed steps (optionally with guidance for
   * each) and run what was held back, and/or drop steps that are no longer needed so the
   * steps after them can go on.
   */
  continueAfterFailure(
    groupId: string,
    decision: { guidance?: Array<{ stepId: string; text: string }>; skip?: Array<{ stepId: string; reason?: string }> },
  ): WorkflowRecord {
    const workflow = this.workflows.get(groupId);
    if (!workflow || workflow.status !== "failed") {
      throw new Error(t("workflowHasNoStepsToContinue"));
    }
    const byId = new Map(workflow.steps.map((s) => [s.id, s]));
    for (const item of decision.skip ?? []) {
      const step = byId.get(item.stepId.trim().toLowerCase());
      if (!step) throw new Error(`Unknown step: ${item.stepId}`);
      if (step.status === "completed") continue;
      step.status = "completed";
      step.error = undefined;
      step.phase = undefined;
      step.output = `(Skipped by the lead${item.reason?.trim() ? `: ${item.reason.trim()}` : ""}. Nothing was produced by this step.)`;
      this.deps.saveResult(groupId, step, step.output);
    }
    for (const item of decision.guidance ?? []) {
      const step = byId.get(item.stepId.trim().toLowerCase());
      if (!step) throw new Error(`Unknown step: ${item.stepId}`);
      if (item.text.trim()) step.retryGuidance = item.text.trim();
    }
    if (workflow.steps.every((s) => s.status === "completed")) {
      workflow.status = "completed";
      workflow.updatedAt = Date.now();
      this.deps.onChange(this.clone(workflow)!);
      return this.clone(workflow)!;
    }
    return this.resume(groupId);
  }

  /** Stops running steps and drops the ones that have not started. */
  cancel(groupId: string): WorkflowRecord {
    const workflow = this.workflows.get(groupId);
    if (!workflow || workflow.status !== "running") {
      return this.get(groupId);
    }
    this.userStopped.add(groupId);
    for (const step of workflow.steps) {
      if (step.status === "pending") {
        step.status = "cancelled";
      } else if (step.status === "running" && step.sessionKey) {
        this.deps.cancel(step.phase === "review" && step.reviewSessionKey ? step.reviewSessionKey : step.sessionKey);
      }
    }
    this.advance(workflow);
    return this.clone(workflow)!;
  }

  private normalizeReview(stepId: string, raw: WorkflowStepInput["review"]): WorkflowStep["review"] {
    const agent = (raw?.agent ?? "").trim().toLowerCase();
    if (!agent) return undefined;
    if (!this.deps.isKnownAgent(agent)) {
      throw new Error(t("reviewerForStepDoesNotExist", stepId, raw?.agent));
    }
    const rounds = Math.floor(Number(raw?.maxRounds));
    return {
      agent,
      criteria: (raw?.criteria ?? "").trim() || undefined,
      maxRounds: Number.isFinite(rounds) && rounds >= 1 ? Math.min(rounds, MAX_REVIEW_ROUNDS) : DEFAULT_REVIEW_ROUNDS,
    };
  }

  /** The step's agent reported done: hand the work to the reviewer. */
  private startReview(workflow: WorkflowRecord, step: WorkflowStep): void {
    const review = step.review!;
    const prompt = [
      "You are the acceptance reviewer for a piece of work another agent just finished. Check it against the task it was given: read the files it changed and run whatever checks are appropriate. Do not redo the work and do not edit files yourself.",
      "",
      "<task>",
      step.prompt,
      "</task>",
      ...(review.criteria ? ["", "<acceptance_criteria>", review.criteria, "</acceptance_criteria>"] : []),
      "",
      `<work_report round="${step.round ?? 1}">`,
      step.output || "(the agent reported nothing)",
      "</work_report>",
      "",
      "List the concrete problems that must be fixed, if any. Then end your reply with exactly one line: `VERDICT: PASS` or `VERDICT: FAIL`.",
    ].join("\n");
    const task = this.deps.dispatch({
      groupId: workflow.groupId,
      agent: review.agent,
      prompt,
      session: `wf-${step.id}-review`,
      isolateWorktree: false,
      contextRefs: step.contextRefs ?? [],
      upstreamStepIds: [],
    });
    step.phase = "review";
    step.taskId = task.taskId;
    step.reviewSessionKey = task.targetSessionKey;
  }

  /** The reviewer answered: accept the step, send it back for another round, or fail it. */
  private finishReview(workflow: WorkflowRecord, step: WorkflowStep, reply: string): void {
    const review = step.review!;
    step.reviewNotes = reply;
    const verdicts = [...reply.matchAll(/VERDICT:\s*\**\s*(PASS|FAIL)/gi)];
    const verdict = verdicts.length > 0 ? verdicts[verdicts.length - 1]![1]!.toUpperCase() : "";
    if (verdict === "PASS") {
      step.status = "completed";
      step.phase = undefined;
      this.deps.saveResult(workflow.groupId, step, step.output ?? "");
      return;
    }
    if (!verdict) {
      step.status = "failed";
      step.errorKind = "reviewVerdictMissing";
      step.error = t(step.errorKind);
      return;
    }
    const round = step.round ?? 1;
    if (round >= review.maxRounds) {
      step.status = "failed";
      step.errorKind = "reviewAttemptsExhausted";
      step.error = t(step.errorKind, round);
      return;
    }
    // Same session as before, so the agent still has its own context for the rework.
    const task = this.deps.dispatch({
      groupId: workflow.groupId,
      agent: step.agent,
      prompt: [
        `The reviewer did not accept your work (review ${round} of ${review.maxRounds}). Fix the problems below, then report what you changed.`,
        "",
        "<review>",
        reply,
        "</review>",
      ].join("\n"),
      session: `wf-${step.id}`,
      isolateWorktree: Boolean(step.isolateWorktree),
      contextRefs: [],
      upstreamStepIds: [],
    });
    step.phase = "work";
    step.round = round + 1;
    step.taskId = task.taskId;
    step.sessionKey = task.targetSessionKey;
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
    const declared = task.status === "completed" && step.phase !== "review" ? parseStepOutcome(task.outputText ?? "") : undefined;
    if (declared && !declared.ok) {
      // The agent's turn ended normally but it says the task did not get done.
      step.status = "failed";
      step.output = task.outputText;
      step.error = declared.reason;
    } else if (task.status === "completed" && step.review) {
      try {
        if (step.phase === "review") {
          this.finishReview(workflow, step, task.outputText ?? "");
        } else {
          step.output = task.outputText;
          this.startReview(workflow, step);
        }
      } catch (err) {
        step.status = "failed";
        step.error = err instanceof Error ? err.message : String(err);
      }
    } else if (task.status === "completed") {
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
            step.errorKind = "serviceRestarted";
            step.error = t(step.errorKind);
          }
        }
        workflow.status = "failed";
      }
      this.workflows.set(workflow.groupId, workflow);
    }
  }

  private advance(workflow: WorkflowRecord): void {
    const byId = new Map(workflow.steps.map((s) => [s.id, s]));
    const limit = Math.max(1, Math.floor(this.deps.maxParallel?.() ?? Number.POSITIVE_INFINITY));
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
        // Ready, but every running step is a set of agent processes: wait for a free slot.
        if (workflow.steps.filter((s) => s.status === "running").length >= limit) continue;
        try {
          const task = this.deps.dispatch({
            groupId: workflow.groupId,
            agent: step.agent,
            // Background and upstream results travel as context, not inside the step prompt.
            prompt: `${step.prompt}${step.retryGuidance ? `\n\n<lead_guidance>\nAn earlier attempt at this step did not succeed. The lead's guidance for this attempt:\n${step.retryGuidance}\n</lead_guidance>` : ""}${STATUS_INSTRUCTION}`,
            session: `wf-${step.id}`,
            isolateWorktree: Boolean(step.isolateWorktree),
            contextRefs: step.contextRefs ?? [],
            upstreamStepIds: deps.map((d) => d.id),
          });
          step.status = "running";
          step.taskId = task.taskId;
          step.sessionKey = task.targetSessionKey;
          if (step.review) {
            step.phase = "work";
            step.round = 1;
          }
        } catch (err) {
          step.status = "failed";
          step.error = err instanceof Error ? err.message : String(err);
        }
        progressed = true;
      }
    }

    const wasRunning = workflow.status === "running";
    const active = workflow.steps.some((s) => s.status === "pending" || s.status === "running");
    if (!active) {
      workflow.status = workflow.steps.every((s) => s.status === "completed") ? "completed" : "failed";
    }
    workflow.updatedAt = Date.now();
    this.deps.onChange(this.clone(workflow)!);
    if (wasRunning && workflow.status !== "running") {
      const stoppedByUser = this.userStopped.delete(workflow.groupId);
      if (!stoppedByUser) this.deps.onSettled?.(this.clone(workflow)!);
    }
  }

  private assertAcyclic(steps: WorkflowStep[]): void {
    const remaining = new Map(steps.map((s) => [s.id, new Set(s.dependsOn)]));
    while (remaining.size > 0) {
      const ready = [...remaining.entries()].filter(([, deps]) => deps.size === 0).map(([id]) => id);
      if (ready.length === 0) {
        throw new Error(t("workflowStepsContainADependencyCycle", [...remaining.keys()].join("、")));
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
