import type { AgentId, AgentModelCatalog, EffortConfigState, ModelOptionItem } from "../types.js";

const EFFORT_ID_NAMES = new Set(["effort", "reasoning_effort", "thought_level", "thinking"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Flattens flat or grouped ACP select options into a deduplicated ModelOptionItem list.
 */
export function flattenSelectOptions(rawOptions: unknown): ModelOptionItem[] {
  if (!Array.isArray(rawOptions)) {
    return [];
  }

  const out: ModelOptionItem[] = [];
  const seen = new Set<string>();

  const pushOpt = (opt: unknown): void => {
    if (!isRecord(opt)) {
      return;
    }
    const rawId = opt.value ?? opt.id;
    if (typeof rawId !== "string" || !rawId.trim()) {
      return;
    }
    const id = rawId.trim();
    if (seen.has(id)) {
      return;
    }
    seen.add(id);
    const name = typeof opt.name === "string" && opt.name.trim() ? opt.name.trim() : id;
    const description =
      typeof opt.description === "string" && opt.description.trim()
        ? opt.description.trim()
        : undefined;
    out.push({ id, name, description });
  };

  for (const entry of rawOptions) {
    if (!isRecord(entry)) {
      continue;
    }
    if (Array.isArray(entry.options)) {
      for (const nested of entry.options) {
        pushOpt(nested);
      }
    } else {
      pushOpt(entry);
    }
  }

  return out;
}

/**
 * Extracts model and thinking/reasoning effort options from ACP session configOptions.
 */
export function extractModelCatalogFromConfigOptions(
  agent: AgentId,
  configOptions: unknown,
  previous?: AgentModelCatalog,
): AgentModelCatalog {
  const now = Date.now();
  const items = Array.isArray(configOptions) ? configOptions : [];

  let modelControl = previous?.modelControl;
  let modelConfigId = previous?.modelConfigId;
  let currentModelId = previous?.currentModelId;
  let models = previous?.models ? [...previous.models] : [];
  let effort: EffortConfigState | undefined = previous?.effort
    ? { ...previous.effort, options: [...previous.effort.options] }
    : undefined;

  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const category = typeof item.category === "string" ? item.category.trim() : "";
    const itemType = typeof item.type === "string" ? item.type.trim() : "";
    const isSelect = itemType === "select" || Array.isArray(item.options);
    if (!isSelect || !id) {
      continue;
    }

    if (category === "model" || id === "model") {
      const parsedModels = flattenSelectOptions(item.options);
      modelControl = "config_option";
      modelConfigId = id;
      if (typeof item.currentValue === "string" && item.currentValue.trim()) {
        currentModelId = item.currentValue.trim();
      }
      if (parsedModels.length > 0) {
        models = parsedModels;
      }
    } else if (category === "thought_level" || EFFORT_ID_NAMES.has(id)) {
      const parsedEffort = flattenSelectOptions(item.options);
      if (parsedEffort.length > 0) {
        effort = {
          configId: id,
          name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : id,
          currentValue:
            typeof item.currentValue === "string" ? item.currentValue.trim() : parsedEffort[0]!.id,
          options: parsedEffort,
        };
      }
    }
  }

  return {
    agent,
    modelControl,
    modelConfigId,
    currentModelId,
    models,
    effort,
    updatedAt: now,
  };
}

/**
 * Extracts model catalog from ACP session/new response, falling back to legacy models field.
 */
export function extractModelCatalogFromNewSession(
  agent: AgentId,
  newSessionResponse: unknown,
): AgentModelCatalog {
  const resp = isRecord(newSessionResponse) ? newSessionResponse : undefined;
  const fromConfig = extractModelCatalogFromConfigOptions(agent, resp?.configOptions);
  if (fromConfig.models.length > 0) {
    return fromConfig;
  }

  const legacy = isRecord(resp?.models) ? resp.models : undefined;
  const availableRaw = Array.isArray(legacy?.availableModels) ? legacy.availableModels : [];
  const models: ModelOptionItem[] = [];
  const seen = new Set<string>();

  for (const item of availableRaw) {
    if (!isRecord(item)) {
      continue;
    }
    const rawId = item.modelId ?? item.id;
    if (typeof rawId !== "string" || !rawId.trim()) {
      continue;
    }
    const id = rawId.trim();
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : id;
    const description =
      typeof item.description === "string" && item.description.trim()
        ? item.description.trim()
        : undefined;
    models.push({ id, name, description });
  }

  if (models.length > 0) {
    return {
      agent,
      modelControl: "legacy_set_model",
      currentModelId:
        typeof legacy?.currentModelId === "string" && legacy.currentModelId.trim()
          ? legacy.currentModelId.trim()
          : models[0]?.id,
      models,
      effort: fromConfig.effort,
      updatedAt: Date.now(),
    };
  }

  return {
    agent,
    models: [],
    effort: fromConfig.effort,
    updatedAt: Date.now(),
  };
}
