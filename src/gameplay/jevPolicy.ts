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

export interface JevPolicyConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  confidenceFloor?: number;
  timeoutMs?: number;
}

export class JevPolicy {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly confidenceFloor: number;
  private readonly timeoutMs: number;

  constructor(config: JevPolicyConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'jev-latest';
    this.baseUrl = (config.baseUrl ?? 'https://api.typesafe.ai').replace(/\/$/, '');
    this.confidenceFloor = config.confidenceFloor ?? 0.2;
    this.timeoutMs = config.timeoutMs ?? 3_000;
  }

  async decide(state: JevWorldState): Promise<TypedGameplayDecision> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          state,
          questions: {
            action: {
              type: 'choice',
              instructions: [
                'Choose the single best immediate Minecraft action for the next few seconds.',
                'Follow strategy.mainGoal and subGoals, but react to the actual world state.',
                'Prefer CONTINUE when currentSkill is running and still making sense.',
                'Use EXPLORE when the desired resource is not currently available as a candidate.',
                'Never choose MINE unless an appropriate block candidate exists.',
                'Never choose ATTACK or HUNT_FOOD unless an appropriate entity candidate exists.',
                'Survival is more important than progress when danger is immediate.',
              ].join(' '),
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
      const rawAction = actionAnswer.choice ?? 'WAIT';
      const confidence = clampConfidence(actionAnswer.confidence);
      let action = validateAction(rawAction);

      if (confidence < this.confidenceFloor) {
        action = state.currentSkill.status === 'running' ? 'CONTINUE' : 'EXPLORE';
      }

      const blockTargetId = validateCandidateChoice(answers.block_target?.choice, state.blockCandidates);
      const entityTargetId = validateCandidateChoice(answers.entity_target?.choice, state.entityCandidates);
      const craftItem = validateCraftItem(answers.craft_item?.choice);
      const direction = validateDirection(answers.direction?.choice);

      const decision: TypedGameplayDecision = {
        action,
        blockTargetId,
        entityTargetId,
        craftItem,
        direction,
        confidence,
        source: 'jev',
      };

      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        kind: 'jev_decision',
        latency_ms: Date.now() - started,
        model: this.model,
        action: decision.action,
        confidence,
        block_target: blockTargetId ?? null,
        entity_target: entityTargetId ?? null,
        craft_item: craftItem ?? null,
        direction: direction ?? null,
        current_skill: state.currentSkill,
        strategy_goal: state.strategy.mainGoal,
        action_probabilities: actionAnswer.probabilities ?? null,
      }));

      return decision;
    } catch (error) {
      const fallback: TypedGameplayDecision = {
        action: state.currentSkill.status === 'running' ? 'CONTINUE' : 'EXPLORE',
        direction: 'E',
        confidence: 0,
        source: 'fallback',
        reason: error instanceof Error ? error.message : String(error),
      };

      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        kind: 'jev_error',
        latency_ms: Date.now() - started,
        message: fallback.reason,
        fallback_action: fallback.action,
      }));
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  }
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
