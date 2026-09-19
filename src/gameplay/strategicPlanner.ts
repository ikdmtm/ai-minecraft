import type { SharedStateBus } from '../cognitive/sharedState.js';
import type { ExecutiveWorldState } from './executiveTypes.js';
import type { SpatialRuntimeContext } from './spatialRuntimeContext.js';

interface StrategyOutput {
  mainGoal: string;
  subGoals: string[];
  assessment: string;
}

export class StrategicPlanner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private requestEpoch = 0;
  private pending: AbortController | null = null;

  constructor(
    private readonly shared: SharedStateBus,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly getState: () => ExecutiveWorldState,
    private readonly onGoalChanged: (goal: string) => void,
    private readonly spatial?: SpatialRuntimeContext,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    if (!this.shared.get().currentGoal) {
      this.apply({
        mainGoal: 'Survive as long as possible in this Hardcore world while continuing to live actively.',
        subGoals: [],
        assessment: 'Fresh spawn. No prescribed progression plan has been chosen yet.',
      });
    }
    this.schedule(750);
  }

  stop(): void {
    this.running = false;
    this.requestEpoch++;
    this.pending?.abort();
    this.pending = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay = 45_000): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.runCycle(); }, delay);
  }

  private async runCycle(): Promise<void> {
    if (!this.running) return;
    if (this.spatial && !this.spatial.isReady()) { this.schedule(750); return; }
    const ticket = this.spatial?.ticket();
    const request = ++this.requestEpoch;
    this.pending?.abort();
    const controller = new AbortController();
    this.pending = controller;
    const timeout = setTimeout(() => controller.abort(), 30000);
    const current = () => this.running && request === this.requestEpoch &&
      !controller.signal.aborted && (!ticket || this.spatial!.matches(ticket));
    const started = Date.now();
    try {
      const state = this.getState();
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          instructions: [
            'You are the long-horizon strategy layer for an autonomous Minecraft Hardcore player.',
            'The public long-term objective is to survive for as many Minecraft days as possible in Hardcore.',
            'Choose your own useful overall objective and 3-6 concrete milestones from the actual world state. Do not assume a standard Minecraft progression route.',
            'Do not issue frame-by-frame movement commands. The executive/task layers handle immediate action selection and execution.',
            'Treat current-world memories as fallible observations tied to this world; use confidence and last-seen information rather than assuming old coordinates are still current.',
            'Global procedure memories survive world resets and summarize what earlier play actually succeeded or failed at. Reuse that experience without assuming the new world has the same locations or resources.',
            'Use available_affordances as the source of truth for what operations are currently executable. Use minecraft_knowledge for neutral item/block/recipe facts. These are not a prescribed progression.',
            'Survival is the objective, but passive hiding forever is not a satisfactory strategy: maintain a sustainable active life that learns the world, develops useful capability, explores when worthwhile, creates things, and takes justified risks.',
            'Never prescribe wood->stone->shelter, an Ender Dragon route, or any other fixed progression unless you independently judge those steps useful from the current state.',
            'Write main_goal, sub_goals, and progress_assessment in concise English so the Jev policy can consume them consistently.',
            'Return JSON only with main_goal, sub_goals, progress_assessment.',
          ].join(' '),
          input: JSON.stringify({
            player: state.player,
            world: state.world,
            inventory: state.inventory,
            facilities: state.facilities,
            minecraft_knowledge: {
              items: state.capabilities.itemSpecs,
              blocks: state.capabilities.blockSpecs,
              reachable_recipes: state.capabilities.recipes,
              currently_craftable: state.capabilities.craft,
              observed_resource_sources: state.capabilities.gather,
            },
            available_affordances: state.capabilities.actions,
            current_goal: state.strategy.mainGoal,
            current_sub_goals: state.strategy.subGoals,
            active_task: state.activeTask,
            semantic_targets: state.targets.slice(0, 16),
            memory: state.memory,
            autonomy: state.autonomy,
            recent_events: state.recentEvents,
          }),
          max_output_tokens: 600,
        }),
      });
      if (!current()) return;
      if (!response.ok) throw new Error(`OpenAI strategy ${response.status}: ${await response.text()}`);
      const data = (await response.json()) as any;
      // Body decoding may complete after a transition even if fetch resolved before it.
      if (!current()) {
        console.log(JSON.stringify({ ts: new Date().toISOString(), kind: 'strategic_stale_decision', spatial_epoch: ticket?.epoch ?? null }));
        return;
      }
      const parsed = parseStrategy(extractResponseText(data));
      if (parsed) {
        this.apply(parsed);
        console.log(JSON.stringify({
          ts: new Date().toISOString(), kind: 'strategic_decision',
          latency_ms: Date.now() - started, spatial_epoch: ticket?.epoch ?? null, output: parsed,
        }));
      }
    } catch (error) {
      if (this.running && request === this.requestEpoch) console.log(JSON.stringify({
        ts: new Date().toISOString(), kind: 'strategic_error', latency_ms: Date.now() - started,
        message: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      clearTimeout(timeout);
      if (this.pending === controller) this.pending = null;
      // An old request must not schedule a second loop after stop/start.
      if (this.running && request === this.requestEpoch) this.schedule();
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
