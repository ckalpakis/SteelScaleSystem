import {
  boolean,
  integer,
  keys,
  object,
  json,
  string,
  WorkforceError,
} from '../workforce/shared.js';
import { parseConfig, type RecoveryConfig } from './contracts.js';
import { classifyFixture, normalizeDecision } from './decisions.js';
import { RecoveryService } from './service.js';
import { recoveryScenarios, type ScenarioState } from './scenarios.js';

export function parseState(value: unknown): ScenarioState {
  const v = object(value);
  keys(v, [
    'active',
    'enabled',
    'optedOut',
    'consent',
    'open',
    'recentEmployee',
    'duplicate',
    'withinHours',
    'attempts',
    'eligible',
  ]);
  return {
    active: boolean(v.active),
    enabled: boolean(v.enabled),
    optedOut: boolean(v.optedOut),
    consent: boolean(v.consent),
    open: boolean(v.open),
    recentEmployee: boolean(v.recentEmployee),
    duplicate: boolean(v.duplicate),
    withinHours: boolean(v.withinHours),
    attempts: integer(v.attempts, 0, 20),
    eligible: boolean(v.eligible),
  };
}
export function simulate(
  config: RecoveryConfig,
  message: string,
  state: ScenarioState,
  now = new Date('2026-09-08T14:00:00Z'),
) {
  const decision = normalizeDecision(
    config,
    classifyFixture(message),
    message,
    state.attempts,
    now,
  );
  const blocks = [
    !state.active ? 'organization_inactive' : null,
    !state.enabled ? 'agent_disabled' : null,
    state.optedOut ? 'opt_out' : null,
    !state.consent ? 'consent_required' : null,
    !state.open ? 'opportunity_closed' : null,
    state.recentEmployee ? 'recent_employee_action' : null,
    state.duplicate ? 'duplicate_dispatch' : null,
    !state.withinHours ? 'outside_operating_hours' : null,
    state.attempts >= config.maximumAttempts ? 'attempt_limit' : null,
    !state.eligible ? 'opportunity_ineligible' : null,
  ].filter(Boolean);
  return {
    version: 1,
    engine: 'offline-scenario-v1',
    simulated: true,
    sideEffects: false,
    decision,
    blocks,
    wouldSend: false,
    explanation:
      'A customer response ends autonomous follow-up. Any displayed answer is approved knowledge for human review, never a live send.',
  };
}
export class RecoverySimulationService extends RecoveryService {
  run(raw: unknown) {
    const v = object(raw);
    keys(v, ['scenarioKey', 'message', 'state', 'config']);
    const fixture = v.scenarioKey
      ? recoveryScenarios.find((s) => s.key === v.scenarioKey)
      : undefined;
    if (v.scenarioKey && !fixture) throw new WorkforceError(404, 'scenario_not_found');
    const message = fixture?.message ?? string(v.message, 1000),
      state = fixture?.state ?? parseState(v.state);
    return this.tx(async (tx, organizationId) => {
      const program = await tx.recoveryProgram.findUnique({
        where: { organizationId },
        include: { runtimeVersion: true },
      });
      const config = parseConfig(v.config ?? program?.runtimeVersion.specialization);
      const result = simulate(config, message, state);
      if (
        (await tx.recoverySimulation.count({
          where: { organizationId, createdAt: { gte: new Date(Date.now() - 86400000) } },
        })) >= 100
      )
        throw new WorkforceError(429, 'simulation_daily_limit');
      return tx.recoverySimulation.create({
        data: {
          organizationId,
          scenarioKey: fixture?.key,
          input: json({ message, state, config }),
          result: json(result),
          createdBy: this.principal.actor,
        },
      });
    }, 'crm:write');
  }
}
