import { ExecutivePolicy } from './executivePolicy.js';
import { EXECUTIVE_TASKS } from './executiveTypes.js';
import { inspectEvaluationProvider, evaluationDuration } from './evaluationPreflight.js';

describe('T07a static provider capability preflight', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected_network'));
  });
  afterEach(() => jest.restoreAllMocks());
  test('auto uses the actual policy selection and does not silently replace JEV', () => {
    const env = { POLICY_PROVIDER: 'auto', TYPESAFE_API_KEY: 'fixture-typesafe', OPENAI_API_KEY: 'fixture-openai' };
    const before = { ...env };
    const report = inspectEvaluationProvider(env);
    expect(report).toMatchObject({ ready: false, effectiveProvider: 'jev', supportedTasks: ['EXECUTE_AFFORDANCE', 'WAIT'] });
    expect(report.missingTasks).toEqual(expect.arrayContaining(['SAVE_PROCEDURE', 'RUN_PROCEDURE', 'RECALL_MEMORY', 'CONSOLIDATE_MEMORY']));
    expect(env).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain('fixture-typesafe');
    expect(JSON.stringify(report)).not.toContain('fixture-openai');
  });
  test('explicit OpenAI has the implemented interface but no remote verification claim', () => {
    const report = inspectEvaluationProvider({ POLICY_PROVIDER: ' OPENAI ', OPENAI_API_KEY: 'fixture-openai',
      TYPESAFE_API_KEY: 'fixture-typesafe', OPENAI_POLICY_MODEL: 'configured-model', STRATEGIC_MODEL: 'configured-planner' });
    expect(report).toMatchObject({ ready: true, requestedProvider: 'openai', effectiveProvider: 'openai',
      executiveModel: 'configured-model', strategicModel: 'configured-planner', remoteModelVerified: false,
      missingTasks: [], supportedTasks: EXECUTIVE_TASKS });
    expect(fetch).not.toHaveBeenCalled();
  });
  test.each(['', 'replace-me', 'changeme'])('missing/placeholder credential %p never passes', value => {
    expect(inspectEvaluationProvider({ POLICY_PROVIDER: 'openai', OPENAI_API_KEY: value }).ready).toBe(false);
    expect(inspectEvaluationProvider({ POLICY_PROVIDER: 'jev', TYPESAFE_API_KEY: value, OPENAI_API_KEY: 'fixture' }).ready).toBe(false);
  });
  test('a placeholder TypeSafe value does not force auto into JEV', () => {
    expect(inspectEvaluationProvider({ TYPESAFE_API_KEY: 'replace-me', OPENAI_API_KEY: 'fixture' }))
      .toMatchObject({ ready: true, effectiveProvider: 'openai' });
  });
  test('typos fail instead of falling through to another provider', () => {
    expect(inspectEvaluationProvider({ POLICY_PROVIDER: 'opneai', OPENAI_API_KEY: 'fixture' }).issues).toContain('invalid_policy_provider');
    expect(fetch).not.toHaveBeenCalled();
  });
  test.each(['0', '-1', '8000ms', '1e3', '300001'])('rejects ambiguous or unbounded policy timeout %s', value => {
    expect(inspectEvaluationProvider({ OPENAI_API_KEY: 'fixture', OPENAI_POLICY_TIMEOUT_MS: value }).ready).toBe(false);
  });
  test.each(['openai', 'jev'] as const)('reported tasks equal the real %s request contract', async provider => {
    let request: any;
    jest.mocked(fetch).mockImplementationOnce(async (_url, options) => {
      request = JSON.parse(String(options?.body));
      return { ok: true, json: async () => provider === 'openai'
        ? { output_text: JSON.stringify({ task: 'WAIT', affordance_id: 'none', confidence: 1 }) }
        : { answers: { task: { choice: 'WAIT', confidence: 1 }, affordance: { choice: 'none' } } } } as Response;
    });
    const env = { POLICY_PROVIDER: provider, OPENAI_API_KEY: 'fixture-openai', TYPESAFE_API_KEY: 'fixture-typesafe' };
    const policy = new ExecutivePolicy({ provider, openaiApiKey: env.OPENAI_API_KEY, typesafeApiKey: env.TYPESAFE_API_KEY });
    const state: any = { revision: 1, capabilities: { actions: [] }, strategy: { mainGoal: '' }, activeTask: { status: 'idle' }, memory: [] };
    await policy.decide(state);
    const tasks = provider === 'openai' ? request.text.format.schema.properties.task.enum : Object.keys(request.questions.task.criteria);
    expect(inspectEvaluationProvider(env).supportedTasks).toEqual(tasks);
    expect(fetch).toHaveBeenCalledTimes(1); // Mocked transport, not a real model call.
  });
  test('duration defaults to a bounded short run', () => {
    expect(evaluationDuration()).toBe(60000);
    expect(evaluationDuration('15')).toBe(15000);
    expect(evaluationDuration('300')).toBe(300000);
  });
  test.each(['', '0', '-1', '14', '301', '60s', '1.5', 'Infinity'])('rejects invalid duration %p', value => {
    expect(() => evaluationDuration(value)).toThrow('evaluation_seconds');
  });
});
