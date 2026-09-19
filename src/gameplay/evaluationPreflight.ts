import { ExecutivePolicy } from './executivePolicy.js';
import { EXECUTIVE_TASKS, type ExecutiveTaskType } from './executiveTypes.js';
import { makeRedactor } from './runRecorder.js';

export interface EvaluationPreflight {
  check: 'static_application_interface';
  ready: boolean;
  requestedProvider: string;
  effectiveProvider: 'openai' | 'jev' | null;
  executiveModel: string | null;
  strategicModel: string;
  supportedTasks: ExecutiveTaskType[];
  missingTasks: ExecutiveTaskType[];
  issues: string[];
  remoteModelVerified: false;
  credentialsVerified: false;
}

/** This describes the actual choice-only adapter, NOT the remote model's ability.
 * A contract test compares these tasks with the request built by ExecutivePolicy.
 */
const JEV_TASKS: ExecutiveTaskType[] = ['EXECUTE_AFFORDANCE', 'WAIT'];
const configured = (value?: string): boolean => Boolean(value?.trim() &&
  !['replace-me', 'changeme'].includes(value.trim()));

/** No filesystem, Minecraft connection, or model request. Never changes provider.
 * Constructor selection uses the real policy so auto resolves just as at runtime.
 */
export function inspectEvaluationProvider(env: NodeJS.ProcessEnv): EvaluationPreflight {
  const requested = env.POLICY_PROVIDER?.trim().toLowerCase() || 'auto';
  const report: EvaluationPreflight = {
    check: 'static_application_interface', ready: false, requestedProvider: requested,
    effectiveProvider: null, executiveModel: null,
    strategicModel: env.STRATEGIC_MODEL?.trim() || 'gpt-5.6-terra',
    supportedTasks: [], missingTasks: [...EXECUTIVE_TASKS], issues: [],
    remoteModelVerified: false, credentialsVerified: false,
  };
  if (!['auto', 'openai', 'jev'].includes(requested)) {
    report.issues.push('invalid_policy_provider');
  } else if (requested === 'jev' && !configured(env.TYPESAFE_API_KEY)) {
    report.issues.push('typesafe_credential_not_configured');
  } else {
    const policy = new ExecutivePolicy({
      provider: requested as 'auto' | 'openai' | 'jev',
      typesafeApiKey: env.TYPESAFE_API_KEY?.trim(), openaiApiKey: env.OPENAI_API_KEY?.trim() || '',
      jevModel: env.JEV_MODEL?.trim() || 'jev-latest',
      openaiModel: env.OPENAI_POLICY_MODEL?.trim() || 'gpt-5.6-luna',
      typesafeBaseUrl: env.TYPESAFE_BASE_URL?.trim() || undefined,
    });
    report.effectiveProvider = policy.getProvider();
    report.executiveModel = policy.getModel();
    report.supportedTasks = policy.getProvider() === 'jev' ? [...JEV_TASKS] : [...EXECUTIVE_TASKS];
    report.missingTasks = EXECUTIVE_TASKS.filter(task => !report.supportedTasks.includes(task));
    if (report.missingTasks.length) report.issues.push('configured_adapter_missing_autonomy_tasks');
  }
  // The strategic planner uses this credential even with the choice-only adapter.
  if (!configured(env.OPENAI_API_KEY)) report.issues.push('openai_credential_not_configured');
  if (env.OPENAI_POLICY_TIMEOUT_MS?.trim() &&
      (!/^\d+$/.test(env.OPENAI_POLICY_TIMEOUT_MS.trim()) || Number(env.OPENAI_POLICY_TIMEOUT_MS) < 1 ||
       Number(env.OPENAI_POLICY_TIMEOUT_MS) > 300000)) report.issues.push('invalid_policy_timeout');
  report.ready = report.issues.length === 0;
  return makeRedactor(env)(report) as EvaluationPreflight;
}

export function evaluationDuration(raw?: string): number {
  if (raw == null) return 60000;
  if (!/^\d+$/.test(raw) || Number(raw) < 15 || Number(raw) > 300) throw new Error('evaluation_seconds_must_be_15_to_300');
  return Number(raw) * 1000;
}

if (require.main === module) {
  require('dotenv').config({ quiet: true });
  const report = inspectEvaluationProvider(process.env);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.ready ? 0 : 2;
}
