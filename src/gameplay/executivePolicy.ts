import { parseOperation, OPERATION_JSON_SCHEMA } from './primitiveOperations.js';
import {
  EXECUTIVE_TASKS,
  type ExecutiveDecision,
  type ExecutiveTaskType,
  type ExecutiveWorldState,
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
      const affordanceIds = ['none', ...state.capabilities.actions.map(action => action.id)];
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
            affordance_reference: capabilityReference(state),
          }),
          max_output_tokens: 1800,
          text: {
            format: {
              type: 'json_schema',
              name: 'minecraft_executive_affordance',
              strict: true,
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  task: { type: 'string', enum: EXECUTIVE_TASKS },
                  affordance_id: { type: 'string', enum: affordanceIds },
                  confidence: { type: 'number', minimum: 0, maximum: 1 },
                  operation: { anyOf: [OPERATION_JSON_SCHEMA, { type: 'null' }] },
                  knowledge_query: { type: ['string', 'null'] },
                  knowledge_offset: { type: ['integer', 'null'] },
                  procedure_name: { type: ['string', 'null'] },
                  evidence_ids: { type: 'array', items: { type: 'string' } },
                  procedure_id: { type: ['string', 'null'] },
                  reason: { type: 'string' },
                },
                required: ['task', 'affordance_id', 'confidence', 'operation', 'knowledge_query', 'knowledge_offset', 'procedure_name', 'evidence_ids', 'procedure_id', 'reason'],
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
        affordance_id: string;
        confidence: number;
        operation: unknown; knowledge_query: string | null; knowledge_offset: number | null;
        procedure_name: string | null; evidence_ids: string[]; procedure_id: string | null; reason: string;
      };

      const decision = normalizeDecision(state, {
        task: validateTask(parsed.task),
        operation: parsed.operation ? parseOperation(parsed.operation) : undefined,
        knowledgeQuery: parsed.knowledge_query ?? undefined, knowledgeOffset: parsed.knowledge_offset ?? undefined,
        procedureName: parsed.procedure_name ?? undefined, evidenceIds: parsed.evidence_ids,
        procedureId: parsed.procedure_id ?? undefined, reason: parsed.reason?.slice(0, 300),
        capabilityId: validateAffordanceId(parsed.affordance_id, state),
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
            affordance_reference: capabilityReference(state),
          },
          questions: {
            task: {
              type: 'choice',
              instructions: executiveInstructions(),
              criteria: { EXECUTE_AFFORDANCE: 'Execute a listed affordance.', WAIT: 'Wait briefly.' },
            },
            affordance: {
              type: 'choice',
              instructions: 'Choose one currently exposed affordance for EXECUTE_AFFORDANCE, otherwise none.',
              criteria: affordanceCriteria(state),
            },
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`TypeSafe executive API ${response.status}: ${await response.text()}`);
      }

      const data = (await response.json()) as JevResponse;
      const answers = data.answers ?? {};
      const decision = normalizeDecision(state, {
        task: validateTask(answers.task?.choice ?? 'WAIT'),
        capabilityId: validateAffordanceId(answers.affordance?.choice, state),
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
      capabilityId: undefined,
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
    'EXECUTE_OPERATION is the general control interface: MOVE, LOOK, BREAK, PLACE, ATTACK, EQUIP, USE, INTERACT_BLOCK, INTERACT_ENTITY, OPEN, CLOSE, TRANSFER, CRAFT, WAIT. You may use it even when an action is absent from the affordance preview. Compose solutions yourself.',
    'The operation adapter does not automatically hunt, cook, choose equipment, build a shelter, or place a missing workbench. Choose those operations and their order yourself. MOVE does not dig or place blocks implicitly.',
    'Use observed coordinates and entity IDs. BREAK/PLACE/OPEN/INTERACT need physical reach; MOVE first when necessary. EQUIP selects a carried item; ATTACK is one strike; USE uses the selected carried item. CRAFT count means recipe executions.',
    'OPEN a block then read autonomy.window. TRANSFER uses its current windowId, sourceSlot, destinationSlot, item and count. Read slot contents after each transfer. CLOSE the window when done. Only the server decides whether a slot accepts an item.',
    'LOOKUP_KNOWLEDGE uses knowledge_query and knowledge_offset to inspect neutral registry and matching server-JAR facts, including items, foods, entity loot, recipes, tags and window slots. Use nextOffset for more results. Missing data is unknown, not proof a mechanic is impossible.',
    'SAVE_PROCEDURE uses a name and 2-12 consecutive verified recentExperience evidence IDs to remember a reusable procedure you actually demonstrated. It stores declarative basic operations, not code. Do not claim to have learned an untested procedure. RUN_PROCEDURE selects a saved procedureId; its targets are rebound in this world and every step is checked.',
    'Candidate procedures are experiments, not guaranteed skills. Prior-world experience is useful but old-world coordinates are not current facts. Consult outcomes and revise plans after failed predictions.',
    'For an intentional wait, use an operation WAIT with durationMs up to 60000 and until=timeout/daylight/night/inventory_changed/window_changed. It can be interrupted by safety changes. A timed-out condition was NOT satisfied.',
    'The code does not provide a progression script. Infer what to do from the current state, Minecraft specifications, long-horizon strategy, remembered experience, and currently executable affordances.',
    'Affordances are mechanically derived from Minecraft state and data: movement to known locations, breaking visible harvestable blocks, attacking observed entities, collecting drops, using or placing carried items, crafting executable recipes, processing recipes exposed by data, interacting with visible blocks, and waiting for a world-time condition.',
    'Do not assume canonical sequences such as wood->stone->shelter or hunt->cook->eat. Compose actions yourself from their preconditions and specifications.',
    'World-scoped memory contains observations tied to the current world. Global procedure memory survives world resets and contains empirical successes/failures from earlier play; use it as experience, not as an absolute rule.',
    'A remembered coordinate is evidence about the current world only. Global memories without coordinates are learned experience that can transfer to new worlds.',
    'Choose EXECUTE_AFFORDANCE only with an affordance_id that is currently exposed. One affordance is one bodily/world operation; after it completes the world is re-observed and you can choose the next operation.',
    'WAIT is appropriate only when there is no useful executable operation now. Prefer condition-based wait affordances over repeated short WAIT decisions when one is available.',
    'Use observed outcomes and procedure-memory success/failure rates to change tactics after failures instead of blindly repeating them.',
    'The deterministic safety kernel may interrupt dangerous actions. Survival is the objective, but strategy and problem solving remain yours.',
  ].join(' ');
}

function capabilityReference(state: ExecutiveWorldState): Record<string, unknown> {
  return {
    affordances: state.capabilities.actions,
    item_specs: state.capabilities.itemSpecs,
    block_specs: state.capabilities.blockSpecs,
    reachable_recipes: state.capabilities.recipes,
    currently_craftable: state.capabilities.craft,
    observed_resource_drops: state.capabilities.gather,
    memory: state.memory,
  };
}

function taskCriteria(): Record<ExecutiveTaskType, string> {
  return {
    EXECUTE_OPERATION: 'Execute a basic game control with explicit arguments.',
    LOOKUP_KNOWLEDGE: 'Query neutral Minecraft specifications.',
    SAVE_PROCEDURE: 'Remember a procedure from verified executed evidence.',
    RUN_PROCEDURE: 'Replay a learned procedure with live target binding.',
    EXECUTE_AFFORDANCE: 'Execute one currently available Minecraft affordance and then re-observe the world.',
    WAIT: 'Briefly do nothing only when no useful affordance should be executed now.',
  };
}

function affordanceCriteria(state: ExecutiveWorldState): Record<string, string> {
  const result: Record<string, string> = { none: 'No affordance selected.' };
  for (const action of state.capabilities.actions) {
    result[action.id] = [
      action.kind,
      action.description,
      `preconditions=${JSON.stringify(action.preconditions)}`,
      `specification=${JSON.stringify(action.specification)}`,
    ].join(' ');
  }
  return result;
}

function validateTask(value: string): ExecutiveTaskType {
  return (EXECUTIVE_TASKS as string[]).includes(value)
    ? value as ExecutiveTaskType
    : 'WAIT';
}

function validateAffordanceId(
  value: string | undefined,
  state: ExecutiveWorldState,
): string | undefined {
  if (!value || value === 'none') return undefined;
  return state.capabilities.actions.some(action => action.id === value)
    ? value
    : undefined;
}

function normalizeDecision(
  state: ExecutiveWorldState,
  decision: ExecutiveDecision,
): ExecutiveDecision {
  if (decision.task === 'EXECUTE_OPERATION') {
    if (!decision.operation) throw new Error('operation_required');
    return decision;
  }
  if (decision.task === 'LOOKUP_KNOWLEDGE') {
    if (!decision.knowledgeQuery?.trim()) throw new Error('knowledge_query_required');
    return decision;
  }
  if (decision.task === 'SAVE_PROCEDURE') {
    if (!decision.procedureName || !Array.isArray(decision.evidenceIds)) throw new Error('procedure_evidence_required');
    return decision;
  }
  if (decision.task === 'RUN_PROCEDURE') {
    if (!decision.procedureId) throw new Error('procedure_id_required');
    return decision;
  }
  if (decision.task === 'EXECUTE_AFFORDANCE') {
    const action = decision.capabilityId
      ? state.capabilities.actions.find(entry => entry.id === decision.capabilityId)
      : undefined;
    if (!action) return asWait(decision, 'invalid_affordance:not_currently_available');
    return {
      ...decision,
      targetId: action.targetId,
    };
  }

  return asWait(decision, decision.reason);
}

function asWait(decision: ExecutiveDecision, reason?: string): ExecutiveDecision {
  return {
    ...decision,
    task: 'WAIT',
    targetId: undefined,
    resource: undefined,
    craftItem: undefined,
    capabilityId: undefined,
    structure: undefined,
    amount: 1,
    reason,
  };
}

function clampConfidence(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value as number));
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
    affordance_id: decision.capabilityId ?? null,
    operation: decision.operation ?? null,
    procedure_id: decision.procedureId ?? null,
    knowledge_query: decision.knowledgeQuery ?? null,
    target_id: decision.targetId ?? null,
    confidence: decision.confidence,
    reason: decision.reason ?? null,
    active_task: state.activeTask,
    strategy_goal: state.strategy.mainGoal,
  }));
}
