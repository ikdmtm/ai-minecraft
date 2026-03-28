export interface ActionPlan {
  goal: string;
  reason: string;
  steps: string[];
}

export type ThreatLevel = 'low' | 'medium' | 'high' | 'critical';

export interface LLMOutput {
  action: ActionPlan;
  commentary: string;
  currentGoalUpdate: string | null;
  threatLevel: ThreatLevel;
}
