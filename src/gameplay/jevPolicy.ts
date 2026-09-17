import {
  COMPASS_DIRECTIONS,
  CRAFT_ITEMS,
  GAMEPLAY_ACTIONS,
  type CompassDirection,
  type CraftItem,
  type GameplayActionType,
  type JevWorldState,
  type TypedGameplayDecision,
  type WorldCandidate,
} from './typedActions.js';

interface JevChoiceAnswer {
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

interface JevResponse {
  answers?: Record<string, JevChoiceAnswer>;
}

interface OpenAITypedResponse {
  action?: string;
  block_target?: string;
  entity_target?: string;
  craft_item?: string;
  direction?: string;
  confidence?: number;
}

export type FastPolicyProvider = 'auto' | 'jev' | 'openai';

export interface JevPolicyConfig {
  apiKey?: string;
  openaiApiKey: string;
  provider?: FastPolicyProvider;
  model?: string;
  openaiModel?: string;
  baseUrl?: string;
  confidenceFloor?: number;
  timeoutMs?: number;
  openaiTimeoutMs?: number;
}

export class JevPolicy {
  private readonly typesafeApiKey: string | null;
  private readonly openaiApiKey: string;
  private readonly provider: 'jev' | 'openai';
  private readonly model: string;
  private readonly openaiModel: string;
  private readonly baseUrl: string;
  private readonly confidenceFloor: number;
  private readonly timeoutMs: number;
  private readonly openaiTimeoutMs: number;

  constructor(config: JevPolicyConfig) {
    this.typesafeApiKey = normalizeSecret(config.apiKey);
    this.openaiApiKey = config.openaiApiKey;
    this.model = config.model ?? 'jev-latest';
    this.openaiModel = config.openaiModel ?? 'gpt-5.6-luna';
    this.baseUrl = (config.baseUrl ?? 'https://api.typesafe.ai').replace(/\/$/, '');
    this.confidenceFloor = config.confidenceFloor ?? 0.2;
    this.timeoutMs = config.timeoutMs ?? 3_000;
    this.openaiTimeoutMs = config.openaiTimeoutMs ?? 8_000;

    const requested = config.provider ?? 'auto';
    if (requested === 'jev' && !this.typesafeApiKey) {
      throw new Error('POLICY_PROVIDER=jev requires TYPESAFE_API_KEY');
    }
    this.provider = requested === 'openai'
      ? 'openai'
      : requested === 'jev'
        ? 'jev'
        : this.typesafeApiKey
          ? 'jev'
          : 'openai';
  }

  getProvider(): 'jev' | 'openai' {
    return this.provider;
  }

  getModel(): string {
    return this.provider === 'jev' ? this.model : this.openaiModel;
  }

  async decide(state: JevWorldState): Promise<TypedGameplayDecision> {
    if (this.provider === 'jev') return this.decideWithJev(state);
    return this.decideWithOpenAI(state);
  }

  private async decideWithJev(state: JevWorldState): Promise<TypedGameplayDecision> {
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
          model: this.model,
          state,
          questions: {
            action: {
              type: 'choice',
              instructions: policyInstructions(),
              criteria: actionCriteria(),
            },
            block_target: {
              type: 'choice',
              instructions: 'If the action needs a block target, choose the best matching block candidate. Otherwise choose none.',
              criteria: candidateCriteria(state.blockCandidates),
            },
            entity_target: {
              type: 'choice',
              instructions: 'If the action needs an entity target, choose the best matching entity candidate. Otherwise choose none.',
              criteria: candidateCriteria(state.entityCandidates),
            },
            craft_item: {
              type: 'choice',
              instructions: 'If CRAFT is useful now, choose the single item that should be crafted next. Otherwise choose none.',
              criteria: craftCriteria(),
            },
            direction: {
              type: 'choice',
              instructions: 'Choose a direction for EXPLORE or FLEE. For other actions choose the direction that would be safest if needed.',
              criteria: directionCriteria(),
            },
          },
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`TypeSafe API ${response.status}: ${body}`);
      }

      const data = (await response.json()) as JevResponse;
      const answers = data.answers ?? {};
      const actionAnswer = answers.action ?? {};
      const confidence = clampConfidence(actionAnswer.confidence);
      const decision = normalizeDecision({
        action: actionAnswer.choice,
        blockTarget: answers.block_target?.choice,
        entityTarget: answers.entity_target?.choice,
        craftItem: answers.craft_item?.choice,
        direction: answers.direction?.choice,
        confidence,
        source: 'jev',
      }, state, this.confidenceFloor);

      logDecision({
        provider: 'jev',
        model: this.model,
        started,
        decision,
        state,
        probabilities: actionAnswer.probabilities ?? null,
      });
      return decision;
    } catch (error) {
      return this.fallback(state, started, 'jev', error);
    } finally {
      clearTimeout(timer);
    }
  }

  private async decideWithOpenAI(state: JevWorldState): Promise<TypedGameplayDecision> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.openaiTimeoutMs);

    try {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.openaiApiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.openaiModel,
          store: false,
          instructions: [
            'You are the fast System One action policy for an autonomous Minecraft Hardcore bot.',
            policyInstructions(),
            'Return only the structured decision required by the schema.',
            'Targets are IDs from the supplied candidate lists. Never invent target IDs.',
          ].join(' '),
          input: JSON.stringify(state),
          max_output_tokens: 160,
          text: {
            format: {
              type: 'json_schema',
              name: 'minecraft_fast_policy',
              strict: true,
              schema: openAIDecisionSchema(state),
            },
          },
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`OpenAI policy API ${response.status}: ${body}`);
      }

      const data = await response.json() as any;
      const text = extractOpenAIResponseText(data);
      const parsed = JSON.parse(text) as OpenAITypedResponse;
      const decision = normalizeDecision({
        action: parsed.action,
        blockTarget: parsed.block_target,
        entityTarget: parsed.entity_target,
        craftItem: parsed.craft_item,
        direction: parsed.direction,
        confidence: clampConfidence(parsed.confidence),
        source: 'openai',
      }, state, this.confidenceFloor);

      logDecision({
        provider: 'openai',
        model: this.openaiModel,
        started,
        decision,
        state,
        probabilities: null,
      });
      return decision;
    } catch (error) {
      return this.fallback(state, started, 'openai', error);
    } finally {
      clearTimeout(timer);
    }
  }

  private fallback(
    state: JevWorldState,
    started: number,
    provider: 'jev' | 'openai',
    error: unknown,
  ): TypedGameplayDecision {
    const fallback: TypedGameplayDecision = {
      action: state.currentSkill.status === 'running' ? 'CONTINUE' : 'EXPLORE',
      direction: 'E',
      confidence: 0,
      source: 'fallback',
      reason: error instanceof Error ? error.message : String(error),
    };

    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      kind: 'policy_error',
      provider,
      latency_ms: Date.now() - started,
      message: fallback.reason,
      fallback_action: fallback.action,
    }));
    return fallback;
  }
}

function policyInstructions(): string {
  return [
    'Choose the single best immediate Minecraft action for the next few seconds.',
    'Follow strategy.mainGoal and subGoals, but react to the actual world state.',
    'Prefer CONTINUE when currentSkill is running, appropriate, and still capable of progress.',
    'Use EXPLORE when the desired resource is not currently available as a candidate.',
    'Never choose MINE unless an appropriate block candidate exists.',
    'Never choose ATTACK or HUNT_FOOD unless an appropriate entity candidate exists.',
    'Choose CRAFT only when inventory plausibly supports the requested recipe.',
    'Survival is more important than progress when danger is immediate.',
  ].join(' ');
}

function openAIDecisionSchema(state: JevWorldState): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: GAMEPLAY_ACTIONS },
      block_target: {
        type: 'string',
        enum: ['none', ...state.blockCandidates.map(candidate => candidate.id)],
      },
      entity_target: {
        type: 'string',
        enum: ['none', ...state.entityCandidates.map(candidate => candidate.id)],
      },
      craft_item: { type: 'string', enum: CRAFT_ITEMS },
      direction: { type: 'string', enum: COMPASS_DIRECTIONS },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['action', 'block_target', 'entity_target', 'craft_item', 'direction', 'confidence'],
  };
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
  if (!text) throw new Error('OpenAI policy returned no output_text');
  return text;
}

function normalizeDecision(
  raw: {
    action?: string;
    blockTarget?: string;
    entityTarget?: string;
    craftItem?: string;
    direction?: string;
    confidence: number;
    source: 'jev' | 'openai';
  },
  state: JevWorldState,
  confidenceFloor: number,
): TypedGameplayDecision {
  let action = validateAction(raw.action ?? 'WAIT');
  if (raw.confidence < confidenceFloor) {
    action = state.currentSkill.status === 'running' ? 'CONTINUE' : 'EXPLORE';
  }

  return {
    action,
    blockTargetId: validateCandidateChoice(raw.blockTarget, state.blockCandidates),
    entityTargetId: validateCandidateChoice(raw.entityTarget, state.entityCandidates),
    craftItem: validateCraftItem(raw.craftItem),
    direction: validateDirection(raw.direction),
    confidence: raw.confidence,
    source: raw.source,
  };
}

function logDecision(args: {
  provider: 'jev' | 'openai';
  model: string;
  started: number;
  decision: TypedGameplayDecision;
  state: JevWorldState;
  probabilities: Record<string, number> | null;
}): void {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    kind: 'policy_decision',
    provider: args.provider,
    latency_ms: Date.now() - args.started,
    model: args.model,
    action: args.decision.action,
    confidence: args.decision.confidence,
    block_target: args.decision.blockTargetId ?? null,
    entity_target: args.decision.entityTargetId ?? null,
    craft_item: args.decision.craftItem ?? null,
    direction: args.decision.direction ?? null,
    current_skill: args.state.currentSkill,
    strategy_goal: args.state.strategy.mainGoal,
    action_probabilities: args.probabilities,
  }));
}

function actionCriteria(): Record<GameplayActionType, string> {
  return {
    CONTINUE: 'Continue the currently running skill because it remains appropriate and is making or can make progress.',
    EXPLORE: 'Move through the world to discover a needed resource, safer terrain, or a better route.',
    MINE: 'Move to and break a specific block candidate such as a log, stone, coal, or iron ore.',
    CRAFT: 'Craft the next concrete progression item from available inventory, using a crafting table when needed.',
    BUILD_SHELTER: 'Build a small protective shelter when night or nearby danger makes protection necessary.',
    HUNT_FOOD: 'Approach and kill a food animal to obtain food when food supply is insufficient.',
    EAT: 'Consume food now because hunger or health recovery makes eating useful.',
    FLEE: 'Create distance from an immediate threat or dangerous location.',
    ATTACK: 'Fight a nearby hostile when combat is necessary and reasonably safe.',
    SLEEP: 'Use a nearby bed at night when sleeping is possible and safer than staying awake.',
    WAIT: 'Do nothing briefly because acting now would be unnecessary or counterproductive.',
  };
}

function candidateCriteria(candidates: WorldCandidate[]): Record<string, string> {
  const result: Record<string, string> = {
    none: 'No candidate is appropriate for the requested target.',
  };
  for (const candidate of candidates) {
    result[candidate.id] = `${candidate.kind} ${candidate.name}, ${candidate.distance} blocks away at (${candidate.position.x}, ${candidate.position.y}, ${candidate.position.z})${candidate.hostile ? ', hostile' : ''}${candidate.foodAnimal ? ', food animal' : ''}`;
  }
  return result;
}

function craftCriteria(): Record<CraftItem, string> {
  return {
    none: 'Do not craft anything right now.',
    planks: 'Convert a log into wooden planks.',
    sticks: 'Craft sticks for tools.',
    crafting_table: 'Craft a crafting table.',
    wooden_pickaxe: 'Craft the first wooden pickaxe to unlock stone mining.',
    wooden_axe: 'Craft a wooden axe for faster wood gathering and basic combat.',
    wooden_sword: 'Craft a wooden sword for early defense.',
    stone_pickaxe: 'Craft a stone pickaxe after obtaining cobblestone.',
    stone_axe: 'Craft a stone axe after obtaining cobblestone.',
    stone_sword: 'Craft a stone sword after obtaining cobblestone.',
    furnace: 'Craft a furnace after obtaining enough cobblestone.',
  };
}

function directionCriteria(): Record<CompassDirection, string> {
  return {
    N: 'north', NE: 'north-east', E: 'east', SE: 'south-east',
    S: 'south', SW: 'south-west', W: 'west', NW: 'north-west',
  };
}

function validateAction(value: string): GameplayActionType {
  return (GAMEPLAY_ACTIONS as string[]).includes(value) ? value as GameplayActionType : 'WAIT';
}

function validateDirection(value: string | undefined): CompassDirection | undefined {
  if (!value) return undefined;
  return (COMPASS_DIRECTIONS as string[]).includes(value) ? value as CompassDirection : undefined;
}

function validateCraftItem(value: string | undefined): CraftItem | undefined {
  if (!value || value === 'none') return undefined;
  return (CRAFT_ITEMS as string[]).includes(value) ? value as CraftItem : undefined;
}

function validateCandidateChoice(value: string | undefined, candidates: WorldCandidate[]): string | undefined {
  if (!value || value === 'none') return undefined;
  return candidates.some(candidate => candidate.id === value) ? value : undefined;
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
