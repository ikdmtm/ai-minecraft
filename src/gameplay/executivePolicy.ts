import {
  EXECUTIVE_TASKS,
  type ExecutiveDecision,
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

interface JevResponse {
  answers?: Record<string, {
    choice?: string;
    confidence?: number;
  }>;
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
          input: JSON.stringify(state),
          max_output_tokens: 384,
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
                  amount: { type: 'integer', minimum: 1, maximum: 32 },
                  confidence: { type: 'number', minimum: 0, maximum: 1 },
                },
                required: ['task', 'target_id', 'amount', 'confidence'],
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
        amount: number;
        confidence: number;
      };

      const decision: ExecutiveDecision = {
        task: validateTask(parsed.task),
        targetId: validateTargetId(parsed.target_id, state.targets),
        amount: clampAmount(parsed.amount),
        confidence: clampConfidence(parsed.confidence),
        source: 'openai',
        basedOnRevision: state.revision,
      };
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
          state,
          questions: {
            task: {
              type: 'choice',
              instructions: executiveInstructions(),
              criteria: taskCriteria(),
            },
            target: {
              type: 'choice',
              instructions: 'Choose a concrete semantic target for the task. Choose none if the task does not require one.',
              criteria: targetCriteria(state.targets),
            },
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`TypeSafe executive API ${response.status}: ${await response.text()}`);
      }

      const data = (await response.json()) as JevResponse;
      const answers = data.answers ?? {};
      const decision: ExecutiveDecision = {
        task: validateTask(answers.task?.choice ?? 'WAIT'),
        targetId: validateTargetId(answers.target?.choice, state.targets),
        amount: defaultAmountForTask(validateTask(answers.task?.choice ?? 'WAIT')),
        confidence: clampConfidence(answers.task?.confidence),
        source: 'jev',
        basedOnRevision: state.revision,
      };
      logDecision(started, this.provider, this.jevModel, state, decision);
      return decision;
    } catch (error) {
      return this.fallback(state, started, error);
    } finally {
      clearTimeout(timer);
    }
  }

  private fallback(state: ExecutiveWorldState, started: number, error: unknown): ExecutiveDecision {
    const nearestLand = bestTarget(state.targets, 'land');
    const bestTree = bestTarget(state.targets, 'tree_cluster');
    let task: ExecutiveTaskType = 'WAIT';
    let targetId: string | undefined;

    if (state.player.inWater && nearestLand) {
      task = 'REACH_LAND';
      targetId = nearestLand.id;
    } else if (totalLogs(state.inventory) < 6 && bestTree) {
      task = 'GATHER_WOOD';
      targetId = bestTree.id;
    } else if (!hasPickaxe(state.inventory) && totalLogs(state.inventory) > 0) {
      task = 'PREPARE_STARTER_TOOLS';
    } else if (hasPickaxe(state.inventory)) {
      task = 'ACQUIRE_STONE';
      targetId = bestTarget(state.targets, 'stone_source')?.id;
    }

    const decision: ExecutiveDecision = {
      task,
      targetId,
      amount: defaultAmountForTask(task),
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
    'You are the executive controller for an autonomous Minecraft Hardcore player.',
    'Choose ONE meaningful task, not a low-level movement.',
    'The task executor will handle navigation, retries, mining, collecting drops, and recipe prerequisites.',
    'Use the semantic targets instead of inventing coordinates.',
    'If player.inWater is true, choose REACH_LAND with the best low-risk land target before resource work.',
    'Use GATHER_WOOD until there is a practical early-game wood buffer (normally 6-10 logs).',
    'Use PREPARE_STARTER_TOOLS when wood exists but no wooden-or-better pickaxe exists.',
    'Use ACQUIRE_STONE once a pickaxe exists. It can dig a safe staircase if no exposed stone target exists.',
    'Use GATHER_FOOD when food is needed and a safe food_source exists.',
    'Use ESTABLISH_SHELTER when night is approaching or strategy prioritizes shelter and the player is on solid land.',
    'CONTINUE_TASK is only appropriate when activeTask.status is running.',
    'Do not micromanage compass directions or individual block hits.',
  ].join(' ');
}

function taskCriteria(): Record<ExecutiveTaskType, string> {
  return {
    CONTINUE_TASK: 'Keep the currently running semantic task.',
    REACH_LAND: 'Reach a concrete safe land target, especially when in water.',
    GATHER_WOOD: 'Acquire a requested buffer of logs from a nearby tree cluster.',
    PREPARE_STARTER_TOOLS: 'Craft prerequisites and a wooden pickaxe / starter tooling.',
    ACQUIRE_STONE: 'Obtain cobblestone using exposed stone or a safe descending staircase.',
    GATHER_FOOD: 'Obtain raw food from a nearby passive animal source.',
    ESTABLISH_SHELTER: 'Build a compact first-night shelter on solid terrain.',
    WAIT: 'Briefly wait because no useful safe task is currently executable.',
  };
}

function targetCriteria(targets: SemanticTarget[]): Record<string, string> {
  const result: Record<string, string> = {
    none: 'This task does not require a semantic target.',
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

function bestTarget(
  targets: SemanticTarget[],
  kind: SemanticTarget['kind'],
): SemanticTarget | undefined {
  return targets.filter(target => target.kind === kind).sort((a, b) => b.score - a.score)[0];
}

function validateTask(value: string): ExecutiveTaskType {
  return (EXECUTIVE_TASKS as string[]).includes(value) ? value as ExecutiveTaskType : 'WAIT';
}

function validateTargetId(value: string | undefined, targets: SemanticTarget[]): string | undefined {
  if (!value || value === 'none') return undefined;
  return targets.some(target => target.id === value) ? value : undefined;
}

function clampAmount(value: number | undefined): number {
  if (!Number.isFinite(value)) return 8;
  return Math.max(1, Math.min(32, Math.round(value as number)));
}

function clampConfidence(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value as number));
}

function defaultAmountForTask(task: ExecutiveTaskType): number {
  switch (task) {
    case 'GATHER_WOOD': return 8;
    case 'ACQUIRE_STONE': return 12;
    case 'GATHER_FOOD': return 4;
    default: return 1;
  }
}

function totalLogs(inventory: Record<string, number>): number {
  return Object.entries(inventory)
    .filter(([name]) => name.endsWith('_log'))
    .reduce((sum, [, count]) => sum + count, 0);
}

function hasPickaxe(inventory: Record<string, number>): boolean {
  return Object.keys(inventory).some(name => name.endsWith('_pickaxe'));
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
    amount: decision.amount ?? null,
    confidence: decision.confidence,
    active_task: state.activeTask,
    strategy_goal: state.strategy.mainGoal,
  }));
}
