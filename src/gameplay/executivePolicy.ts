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
          max_output_tokens: 256,
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
                },
                required: ['task', 'affordance_id', 'confidence'],
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
      };

      const decision = normalizeDecision(state, {
        task: validateTask(parsed.task),
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
              criteria: taskCriteria(),
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
    'The code does not provide a progression script. Infer what to do from the current state, Minecraft specifications, long-horizon strategy, remembered experience, and currently executable affordances.',
    'Affordances are mechanically derived from Minecraft state and data: movement to known locations, breaking visible harvestable blocks, attacking observed entities, collecting drops, using or placing carried items, crafting executable recipes, processing recipes exposed by data, interacting with visible blocks, and waiting for a world-time condition.',
    'Do not assume canonical sequences such as wood->stone->shelter or hunt->cook->eat. Compose actions yourself from their preconditions and specifications.',
    'World-scoped memory contains observations tied to the current world. Global procedure memory survives world resets and contains empirical successes/failures from earlier play; use it as experience, not as an absolute rule.',
    'A remembered coordinate is evidence about the current world only. Global memories without coordinates are learned experience that can transfer to new worlds.',
    'Choose EXECUTE_AFFORDANCE only with an affordance_id that is currently exposed. One affordance is one bodily/world operation; after it completes the world is re-observed and you can choose the next operation.',
    'CONTINUE_TASK is only valid while a task is actually running.',
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
    CONTINUE_TASK: 'Continue the currently running operation only when one is still active.',
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
  if (decision.task === 'CONTINUE_TASK' && state.activeTask.status !== 'running') {
    return asWait(decision, 'invalid_task:no_running_task');
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
    target_id: decision.targetId ?? null,
    confidence: decision.confidence,
    reason: decision.reason ?? null,
    active_task: state.activeTask,
    strategy_goal: state.strategy.mainGoal,
  }));
}
