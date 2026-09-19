import {
  EXECUTIVE_STRUCTURES,
  EXECUTIVE_TASKS,
  type ExecutiveDecision,
  type ExecutiveResource,
  type ExecutiveStructure,
  type ExecutiveTaskType,
  type ExecutiveWorldState,
  type SemanticTarget,
} from './executiveTypes.js';

interface ExecutivePolicyConfig {
  typesafeApiKey?: string;
  openaiApiKey: string;
  provider?: 'auto' | 'jev' | 'openai';
  jevModel?: string;
  openaiModel?: string;
  typesafeBaseUrl?: string;
  timeoutMs?: number;
}

interface JevChoiceAnswer {
  choice?: string;
  confidence?: number;
}

interface JevResponse {
  answers?: Record<string, JevChoiceAnswer>;
}

export class ExecutivePolicy {
  private readonly provider: 'jev' | 'openai';
  private readonly typesafeApiKey: string | null;
  private readonly jevModel: string;
  private readonly openaiModel: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: ExecutivePolicyConfig) {
    this.typesafeApiKey = normalizeSecret(config.typesafeApiKey);
    const requested = config.provider ?? 'auto';
    if (requested === 'jev' && !this.typesafeApiKey) {
      throw new Error('POLICY_PROVIDER=jev requires TYPESAFE_API_KEY');
    }
    this.provider = requested === 'jev'
      ? 'jev'
      : requested === 'openai'
        ? 'openai'
        : this.typesafeApiKey
          ? 'jev'
          : 'openai';
    this.jevModel = config.jevModel ?? 'jev-latest';
    this.openaiModel = config.openaiModel ?? 'gpt-5.6-luna';
    this.baseUrl = (config.typesafeBaseUrl ?? 'https://api.typesafe.ai').replace(/\/$/, '');
    this.timeoutMs = config.timeoutMs ?? 8_000;
  }

  getProvider(): 'jev' | 'openai' {
    return this.provider;
  }

  getModel(): string {
    return this.provider === 'jev' ? this.jevModel : this.openaiModel;
  }

  async decide(state: ExecutiveWorldState): Promise<ExecutiveDecision> {
    if (this.provider === 'jev') return this.decideWithJev(state);
    return this.decideWithOpenAI(state);
  }

  private async decideWithOpenAI(state: ExecutiveWorldState): Promise<ExecutiveDecision> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const targetIds = ['none', ...state.targets.map(target => target.id)];
      const resourceOptions = dynamicResourceOptions(state);
      const craftOptions = dynamicCraftOptions(state);
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.openaiApiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.openaiModel,
          store: false,
          reasoning: { effort: 'none' },
          instructions: executiveInstructions(),
          input: JSON.stringify({
            ...state,
            capability_reference: capabilityReference(state),
          }),
          max_output_tokens: 512,
          text: {
            format: {
              type: 'json_schema',
              name: 'minecraft_executive_task',
              strict: true,
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  task: { type: 'string', enum: EXECUTIVE_TASKS },
                  target_id: { type: 'string', enum: targetIds },
                  resource: { type: 'string', enum: resourceOptions },
                  craft_item: { type: 'string', enum: craftOptions },
                  structure: { type: 'string', enum: EXECUTIVE_STRUCTURES },
                  amount: { type: 'integer', minimum: 1, maximum: 32 },
                  confidence: { type: 'number', minimum: 0, maximum: 1 },
                },
                required: [
                  'task',
                  'target_id',
                  'resource',
                  'craft_item',
                  'structure',
                  'amount',
                  'confidence',
                ],
              },
            },
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI executive API ${response.status}: ${await response.text()}`);
      }

      const data = await response.json() as any;
      if (data?.status === 'incomplete') {
        throw new Error(`OpenAI executive incomplete:${data?.incomplete_details?.reason ?? 'unknown'}`);
      }
      const parsed = JSON.parse(extractOpenAIResponseText(data)) as {
        task: string;
        target_id: string;
        resource: string;
        craft_item: string;
        structure: string;
        amount: number;
        confidence: number;
      };

      const decision = normalizeDecisionParameters(state, {
        task: validateTask(parsed.task),
        targetId: validateTargetId(parsed.target_id, state.targets),
        resource: validateResource(parsed.resource, state),
        craftItem: validateCraftItem(parsed.craft_item, state),
        structure: validateStructure(parsed.structure),
        amount: clampAmount(parsed.amount),
        confidence: clampConfidence(parsed.confidence),
        source: 'openai',
        basedOnRevision: state.revision,
      });
      logDecision(started, this.provider, this.openaiModel, state, decision);
      return decision;
    } catch (error) {
      return this.fallback(state, started, error);
    } finally {
      clearTimeout(timer);
    }
  }

  private async decideWithJev(state: ExecutiveWorldState): Promise<ExecutiveDecision> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.typesafeApiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.jevModel,
          state: {
            ...state,
            capability_reference: capabilityReference(state),
          },
          questions: {
            task: {
              type: 'choice',
              instructions: executiveInstructions(),
              criteria: taskCriteria(),
            },
            target: {
              type: 'choice',
              instructions: 'Choose a semantic target only when it is useful for the selected task. Otherwise choose none.',
              criteria: targetCriteria(state.targets),
            },
            resource: {
              type: 'choice',
              instructions: 'Choose the resource for GATHER_RESOURCE, otherwise none.',
              criteria: resourceCriteria(state),
            },
            craft_item: {
              type: 'choice',
              instructions: 'Choose the concrete item for CRAFT_ITEM, otherwise none.',
              criteria: craftCriteria(state),
            },
            structure: {
              type: 'choice',
              instructions: 'Choose the structure for BUILD_STRUCTURE, otherwise none.',
              criteria: structureCriteria(),
            },
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`TypeSafe executive API ${response.status}: ${await response.text()}`);
      }

      const data = (await response.json()) as JevResponse;
      const answers = data.answers ?? {};
      const decision = normalizeDecisionParameters(state, {
        task: validateTask(answers.task?.choice ?? 'WAIT'),
        targetId: validateTargetId(answers.target?.choice, state.targets),
        resource: validateResource(answers.resource?.choice, state),
        craftItem: validateCraftItem(answers.craft_item?.choice, state),
        structure: validateStructure(answers.structure?.choice),
        amount: defaultAmount(),
        confidence: clampConfidence(answers.task?.confidence),
        source: 'jev',
        basedOnRevision: state.revision,
      });
      logDecision(started, this.provider, this.jevModel, state, decision);
      return decision;
    } catch (error) {
      return this.fallback(state, started, error);
    } finally {
      clearTimeout(timer);
    }
  }

  private fallback(state: ExecutiveWorldState, started: number, error: unknown): ExecutiveDecision {
    const decision: ExecutiveDecision = {
      task: 'WAIT',
      resource: 'none',
      craftItem: 'none',
      structure: 'none',
      amount: 1,
      confidence: 0,
      source: 'fallback',
      basedOnRevision: state.revision,
      reason: error instanceof Error ? error.message : String(error),
    };

    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      kind: 'executive_policy_error',
      provider: this.provider,
      latency_ms: Date.now() - started,
      message: decision.reason,
      fallback_task: decision.task,
      state_revision: state.revision,
    }));
    return decision;
  }
}

function executiveInstructions(): string {
  return [
    'You are the executive controller of an autonomous Minecraft Hardcore player.',
    'Decide the next action from the current world state, inventory, long-horizon strategy, recent failures, semantic targets, and dynamically discovered capabilities.',
    'Capabilities are affordances, not a progression script. Do not assume wood->stone->shelter or any other canonical route.',
    'Choose one executable task and its parameters. The body handles pathfinding, physical mining, crafting execution, and short certified excavation segments.',
    'For GATHER_RESOURCE choose a concrete resource exposed by state.capabilities.gather. amount is the desired TOTAL inventory count.',
    'For CRAFT_ITEM choose only an item exposed by state.capabilities.craft. These are recipes currently executable from Minecraft recipe data. amount means the desired TOTAL count of that crafted item in inventory, just like GATHER_RESOURCE.',
    'EXCAVATE_TARGET opens one short world-model-certified excavation segment to discover or access terrain; it is not tied to any specific resource.',
    'ATTACK_TARGET acts on a concrete observed entity. Decide yourself whether attacking it serves the current plan and survival objective.',
    'Use semantic target IDs when a location, resource source, or entity matters. Never invent coordinates or target IDs.',
    'resource_source targets identify visible harvestable blocks and the inventory resource their Minecraft drop data produces.',
    'item_drop targets are recoverable dropped items. known_structure targets are persistent remembered places.',
    'For BUILD_STRUCTURE(shelter), use a shelter_site only when a new shelter is actually useful. The current shelter body requires one wooden door and at least eight structural blocks already in inventory; satisfy those prerequisites explicitly with CRAFT_ITEM/GATHER_RESOURCE instead of expecting BUILD_STRUCTURE to craft them.',
    'Reuse existing facilities and remembered structures. Do not duplicate work without a reason.',
    'Use recent failures to change approach instead of blindly repeating the same failed task. If BUILD_STRUCTURE has just failed for a systemic crafting/material reason, do not retry the same build unchanged until the missing prerequisite or execution state has changed.',
    'Safety emergencies are handled by a separate deterministic reflex layer; still avoid obviously unreasonable voluntary risks.',
  ].join(' ');
}

function capabilityReference(state: ExecutiveWorldState): Record<string, unknown> {
  const woodenDoors = Object.entries(state.inventory)
    .filter(([name]) => name.endsWith('_door') && name !== 'iron_door')
    .reduce((sum, [, count]) => sum + count, 0);
  const structuralBlocks = Object.entries(state.inventory)
    .filter(([name]) =>
      name === 'dirt' ||
      name === 'cobblestone' ||
      name.endsWith('_planks') ||
      name.endsWith('_log'),
    )
    .reduce((sum, [, count]) => sum + count, 0);

  return {
    NAVIGATE_TARGET: 'Move to a supplied semantic target.',
    GATHER_RESOURCE: state.capabilities.gather,
    EXCAVATE_TARGET: state.capabilities.canExcavate
      ? 'Open one short certified excavation segment at an excavation_site, then re-observe.'
      : 'Unavailable: no certified excavation site.',
    ATTACK_TARGET: state.capabilities.entityActions,
    CRAFT_ITEM: state.capabilities.craft,
    BUILD_STRUCTURE: {
      shelter: {
        description: 'Build the current compact enclosed shelter template at a shelter_site.',
        prerequisites: {
          woodenDoorRequired: 1,
          structuralBlocksRequired: 8,
        },
        available: {
          woodenDoors,
          structuralBlocks,
        },
      },
    },
    CONTINUE_TASK: 'Continue a running task when it remains appropriate.',
    WAIT: 'Do nothing briefly when no useful executable action is available.',
  };
}

function taskCriteria(): Record<ExecutiveTaskType, string> {
  return {
    CONTINUE_TASK: 'Keep the currently running task.',
    NAVIGATE_TARGET: 'Move to a selected semantic target for positioning, approach, retreat, or relocation.',
    GATHER_RESOURCE: 'Acquire a dynamically available concrete resource to a desired inventory total.',
    EXCAVATE_TARGET: 'Open one short certified excavation segment to discover or access terrain.',
    ATTACK_TARGET: 'Attack a selected observed entity when that serves the current plan.',
    CRAFT_ITEM: 'Craft a currently executable item selected from Minecraft recipe data.',
    BUILD_STRUCTURE: 'Build a selected structure at a suitable semantic target.',
    WAIT: 'Briefly wait when acting would not improve the situation.',
  };
}

function targetCriteria(targets: SemanticTarget[]): Record<string, string> {
  const result: Record<string, string> = {
    none: 'No semantic target is needed.',
  };
  for (const target of targets) {
    result[target.id] = [
      target.kind,
      `distance=${target.distance}`,
      `risk=${target.risk}`,
      `score=${Math.round(target.score)}`,
      JSON.stringify(target.metadata),
    ].join(' ');
  }
  return result;
}

function resourceCriteria(state: ExecutiveWorldState): Record<string, string> {
  const result: Record<string, string> = { none: 'No resource parameter.' };
  for (const capability of state.capabilities.gather) {
    result[capability.resource] =
      `Harvest ${capability.resource} from observed source blocks: ${capability.sourceBlocks.join(', ')}`;
  }
  return result;
}

function craftCriteria(state: ExecutiveWorldState): Record<string, string> {
  const result: Record<string, string> = { none: 'No craft item.' };
  for (const capability of state.capabilities.craft) {
    result[capability.item] =
      `Craft ${capability.item}; requiresTable=${capability.requiresTable}; executableRecipeCount=${capability.recipeCount}`;
  }
  return result;
}

function structureCriteria(): Record<ExecutiveStructure, string> {
  return {
    none: 'No structure parameter.',
    shelter: 'Compact enclosed shelter with a usable entrance.',
  };
}

function validateTask(value: string): ExecutiveTaskType {
  return (EXECUTIVE_TASKS as string[]).includes(value) ? value as ExecutiveTaskType : 'WAIT';
}

function validateResource(value: string | undefined, state: ExecutiveWorldState): ExecutiveResource {
  if (!value || value === 'none') return 'none';
  return state.capabilities.gather.some(entry => entry.resource === value) ? value : 'none';
}

function validateCraftItem(value: string | undefined, state: ExecutiveWorldState): string {
  if (!value || value === 'none') return 'none';
  return state.capabilities.craft.some(entry => entry.item === value) ? value : 'none';
}

function validateStructure(value: string | undefined): ExecutiveStructure {
  return (EXECUTIVE_STRUCTURES as string[]).includes(value ?? '') ? value as ExecutiveStructure : 'none';
}

function validateTargetId(value: string | undefined, targets: SemanticTarget[]): string | undefined {
  if (!value || value === 'none') return undefined;
  return targets.some(target => target.id === value) ? value : undefined;
}

function clampAmount(value: number | undefined): number {
  if (!Number.isFinite(value)) return defaultAmount();
  return Math.max(1, Math.min(32, Math.round(value as number)));
}

function defaultAmount(): number {
  return 4;
}

function clampConfidence(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value as number));
}

function normalizeDecisionParameters(
  state: ExecutiveWorldState,
  decision: ExecutiveDecision,
): ExecutiveDecision {
  let targetId = decision.targetId;
  const target = targetId ? state.targets.find(candidate => candidate.id === targetId) : undefined;

  if (decision.task === 'GATHER_RESOURCE') {
    const resource = decision.resource ?? 'none';
    if (target) {
      const targetResource = typeof target.metadata.resource === 'string'
        ? target.metadata.resource
        : typeof target.metadata.itemName === 'string'
          ? target.metadata.itemName
          : null;
      if (
        !['resource_source', 'item_drop'].includes(target.kind) ||
        (targetResource && targetResource !== resource)
      ) {
        targetId = undefined;
      }
    }
  } else if (decision.task === 'EXCAVATE_TARGET') {
    if (target?.kind !== 'excavation_site') targetId = undefined;
  } else if (decision.task === 'ATTACK_TARGET') {
    if (target?.kind !== 'entity') targetId = undefined;
  } else if (
    decision.task === 'BUILD_STRUCTURE' &&
    decision.structure === 'shelter' &&
    target?.kind !== 'shelter_site'
  ) {
    targetId = undefined;
  }

  return { ...decision, targetId };
}

function dynamicResourceOptions(state: ExecutiveWorldState): string[] {
  return ['none', ...new Set(state.capabilities.gather.map(entry => entry.resource))];
}

function dynamicCraftOptions(state: ExecutiveWorldState): string[] {
  return ['none', ...new Set(state.capabilities.craft.map(entry => entry.item))];
}

function normalizeSecret(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  if (!trimmed || trimmed === 'replace-me' || trimmed === 'changeme') return null;
  return trimmed;
}

function extractOpenAIResponseText(data: any): string {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  const parts: string[] = [];
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') parts.push(content.text);
    }
  }
  const text = parts.join('\n').trim();
  if (!text) throw new Error('Executive policy returned no output_text');
  return text;
}

function logDecision(
  started: number,
  provider: 'jev' | 'openai',
  model: string,
  state: ExecutiveWorldState,
  decision: ExecutiveDecision,
): void {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    kind: 'executive_decision',
    provider,
    model,
    latency_ms: Date.now() - started,
    state_revision: state.revision,
    task: decision.task,
    target_id: decision.targetId ?? null,
    resource: decision.resource ?? null,
    craft_item: decision.craftItem ?? null,
    structure: decision.structure ?? null,
    amount: decision.amount ?? null,
    confidence: decision.confidence,
    active_task: state.activeTask,
    strategy_goal: state.strategy.mainGoal,
  }));
}
