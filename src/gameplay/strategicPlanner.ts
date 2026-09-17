import type { SharedStateBus } from '../cognitive/sharedState.js';
import type { JevWorldState } from './typedActions.js';

interface StrategyOutput {
  mainGoal: string;
  subGoals: string[];
  assessment: string;
}

export class StrategicPlanner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly shared: SharedStateBus,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly getState: () => JevWorldState,
    private readonly onGoalChanged: (goal: string) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    if (!this.shared.get().currentGoal) {
      this.apply({
        mainGoal: 'Acquire wood and establish basic tools.',
        subGoals: [
          'Find a reachable tree.',
          'Collect at least 6 logs.',
          'Craft planks and a crafting table.',
          'Craft a wooden pickaxe.',
          'Collect stone and upgrade to stone tools.',
        ],
        assessment: 'Fresh spawn with no equipment.',
      });
    }
    this.schedule(750);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay = 45_000): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.runCycle(), delay);
  }

  private async runCycle(): Promise<void> {
    if (!this.running) return;
    const started = Date.now();
    try {
      const state = this.getState();
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          instructions: [
            'You are the long-horizon strategy layer for an autonomous Minecraft Hardcore player.',
            'Choose a useful overall objective and 3-6 concrete milestones.',
            'Do not issue frame-by-frame movement commands. Jev handles immediate action selection.',
            'Priority order: survive immediate danger, establish safety, improve capability, explore/progress, take reasonable challenges.',
            'Do not optimize for hiding forever. Progress through ordinary Minecraft while protecting the single Hardcore life.',
            'Write main_goal, sub_goals, and progress_assessment in concise English so the Jev policy can consume them consistently.',
            'Return JSON only with main_goal, sub_goals, progress_assessment.',
          ].join(' '),
          input: JSON.stringify({
            player: state.player,
            world: state.world,
            inventory: state.inventory,
            current_goal: state.strategy.mainGoal,
            current_skill: state.currentSkill,
            nearby_blocks: state.blockCandidates.slice(0, 10),
            nearby_entities: state.entityCandidates.slice(0, 10),
            recent_events: state.recentEvents,
          }),
          max_output_tokens: 600,
        }),
      });
      if (!response.ok) throw new Error(`OpenAI strategy ${response.status}: ${await response.text()}`);
      const data = (await response.json()) as any;
      const text = extractResponseText(data);
      const parsed = parseStrategy(text);
      if (parsed) {
        this.apply(parsed);
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          kind: 'strategic_decision',
          latency_ms: Date.now() - started,
          output: parsed,
        }));
      }
    } catch (error) {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        kind: 'strategic_error',
        latency_ms: Date.now() - started,
        message: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      this.schedule();
    }
  }

  private apply(output: StrategyOutput): void {
    if (output.mainGoal) {
      this.shared.setGoal(output.mainGoal);
      this.onGoalChanged(output.mainGoal);
    }
    this.shared.setSubGoals(output.subGoals);
    this.shared.markStrategicUpdate();
  }
}

function extractResponseText(data: any): string {
  if (typeof data?.output_text === 'string') return data.output_text;
  const parts: string[] = [];
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('\n');
}

function parseStrategy(raw: string): StrategyOutput | null {
  const match = raw.trim().match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = match ? match[1].trim() : raw.trim();
  if (!candidate.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(candidate);
    const mainGoal = typeof parsed.main_goal === 'string' ? parsed.main_goal.trim() : '';
    const subGoals = Array.isArray(parsed.sub_goals)
      ? parsed.sub_goals.filter((value: unknown) => typeof value === 'string').slice(0, 6)
      : [];
    const assessment = typeof parsed.progress_assessment === 'string' ? parsed.progress_assessment : '';
    return mainGoal ? { mainGoal, subGoals, assessment } : null;
  } catch {
    return null;
  }
}
