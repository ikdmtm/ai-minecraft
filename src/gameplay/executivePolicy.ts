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
            capability_reference: capabilityReference(),
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
                  resource: { type: 'string', enum: EXECUTIVE_RESOURCES },
                  craft_item: { type: 'string', enum: CRAFT_ITEMS },
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
        resource: validateResource(parsed.resource),
        craftItem: validateCraftItem(parsed.craft_item),
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
            capability_reference: capabilityReference(),
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
              criteria: resourceCriteria(),
            },
            craft_item: {
              type: 'choice',
              instructions: 'Choose the concrete item for CRAFT_ITEM, otherwise none.',
              criteria: craftCriteria(),
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
        resource: validateResource(answers.resource?.choice),
        craftItem: validateCraftItem(answers.craft_item?.choice),
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
    'Decide what the player should do next from the current world state, inventory, strategy, recent failures, time, threats, and semantic targets.',
    'The capabilities listed in capability_reference describe what the body can currently attempt; they are NOT a prescribed progression order.',
    'Do not follow a fixed wood->stone->shelter script unless the actual situation and strategy make that the best choice.',
    'Choose one task and its parameters. The task executor handles low-level pathfinding, repeated mining, collection, and crafting mechanics.',
    'For GATHER_RESOURCE, amount means the desired TOTAL amount of that resource in inventory when the task finishes, not an additional amount.',
    'Use semantic target IDs when a location or entity target matters. Never invent coordinates or target IDs.',
    'For logs use a tree_cluster target; for food use a food_source; for cobblestone prefer a visible stone_source or otherwise an excavation_site.',
    'item_drop targets are recoverable dropped resources; use NAVIGATE_TARGET when collecting nearby drops is important.',
    'known_structure targets are persistent remembered places the bot already built. A known_structure with structureKind=shelter is an existing completed shelter that can be revisited with NAVIGATE_TARGET.',
    'For BUILD_STRUCTURE(shelter), use a shelter_site target only when a genuinely new shelter is needed.',
    'Reuse nearby facilities shown in state.facilities; do not craft duplicate workstations unless there is a concrete reason.',
    'If state.facilities.shelterNearby is true, treat an existing completed shelter as available and do not build another one unless relocation is genuinely needed.',
    'If a previous task failed, use its error in recentEvents to choose a different approach instead of blindly repeating it.',
    'Prefer coherent purposeful behavior over frequent task switching.',
    'Safety emergencies are handled by a separate deterministic kernel; you still should avoid obviously unreasonable risks.',
  ].join(' ');
}

function capabilityReference(): Record<string, string> {
  return {
    NAVIGATE_TARGET: 'Move to one supplied semantic target such as land, a tree cluster, stone source, food source, dropped item, remembered structure, or shelter site.',
    GATHER_RESOURCE: 'Reach a desired total inventory amount of a resource. Supported resource abstractions today: logs, cobblestone, food.',
    CRAFT_ITEM: 'Craft one concrete supported item. Recipe prerequisites and crafting-table placement are handled by the body where possible.',
    BUILD_STRUCTURE: 'Build one supported structure at an appropriate semantic target. Supported structure today: shelter.',
    CONTINUE_TASK: 'Continue a currently running task when it remains appropriate.',
    WAIT: 'Do nothing briefly when no useful executable action is appropriate.',
  };
}

function taskCriteria(): Record<ExecutiveTaskType, string> {
  return {
    CONTINUE_TASK: 'Keep the currently running task.',
    NAVIGATE_TARGET: 'Move to a selected semantic target for positioning, retreat, approach, or relocation.',
    GATHER_RESOURCE: 'Acquire a selected resource in a selected amount.',
    CRAFT_ITEM: 'Craft a selected concrete item because it is useful for the chosen plan.',
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

function resourceCriteria(): Record<ExecutiveResource, string> {
  return {
    none: 'No resource parameter.',
    logs: 'Wood logs.',
    cobblestone: 'Cobblestone for tools/building/furnace.',
    food: 'Raw edible animal drops.',
  };
}

function craftCriteria(): Record<CraftItem, string> {
  return Object.fromEntries(
    CRAFT_ITEMS.map(item => [item, item === 'none' ? 'No craft item.' : `Craft ${item}.`]),
  ) as Record<CraftItem, string>;
}

function structureCriteria(): Record<ExecutiveStructure, string> {
  return {
    none: 'No structure parameter.',
    shelter: 'Compact enclosed emergency/first-night shelter.',
  };
}

function validateTask(value: string): ExecutiveTaskType {
  return (EXECUTIVE_TASKS as string[]).includes(value) ? value as ExecutiveTaskType : 'WAIT';
}

function validateResource(value: string | undefined): ExecutiveResource {
  return (EXECUTIVE_RESOURCES as string[]).includes(value ?? '') ? value as ExecutiveResource : 'none';
}

function validateCraftItem(value: string | undefined): CraftItem {
  return (CRAFT_ITEMS as string[]).includes(value ?? '') ? value as CraftItem : 'none';
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
    const compatibleKinds: Record<ExecutiveResource, SemanticTarget['kind'][]> = {
      none: [],
      logs: ['tree_cluster'],
      cobblestone: ['stone_source', 'excavation_site'],
      food: ['food_source'],
    };
    if (target && !compatibleKinds[decision.resource ?? 'none'].includes(target.kind)) {
      targetId = undefined;
    }
  } else if (
    decision.task === 'BUILD_STRUCTURE' &&
    decision.structure === 'shelter' &&
    target?.kind !== 'shelter_site'
  ) {
    targetId = undefined;
  }

  return { ...decision, targetId };
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
