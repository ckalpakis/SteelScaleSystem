import { integer, keys, object, string, WorkforceError } from '../shared.js';

export interface RecoveryConfig {
  version: 1;
  staleAfterDays: number;
  maxCandidates: number;
  allowedTools: ['recovery.prepare_handoff'];
  requireApproval: true;
}

export const defaultRecoveryConfig: RecoveryConfig = {
  version: 1,
  staleAfterDays: 7,
  maxCandidates: 50,
  allowedTools: ['recovery.prepare_handoff'],
  requireApproval: true,
};

export function parseRecoveryConfig(value: unknown): RecoveryConfig {
  const input = object(value);
  keys(input, ['version', 'staleAfterDays', 'maxCandidates', 'allowedTools', 'requireApproval']);
  if (
    input.version !== 1 ||
    input.requireApproval !== true ||
    !Array.isArray(input.allowedTools) ||
    input.allowedTools.length !== 1 ||
    input.allowedTools[0] !== 'recovery.prepare_handoff'
  ) {
    throw new WorkforceError(400, 'unsupported_agent_policy');
  }
  return {
    version: 1,
    staleAfterDays: integer(input.staleAfterDays, 1, 365),
    maxCandidates: integer(input.maxCandidates, 1, 100),
    allowedTools: ['recovery.prepare_handoff'],
    requireApproval: true,
  };
}

// Future model adapters return untrusted structured data, never executable code or tools.
export interface AgentConfigCompiler {
  compile(description: string): Promise<unknown>;
}

export async function proposeRecoveryConfig(description: unknown, compiler?: AgentConfigCompiler) {
  const instructions = string(description, 4000);
  const config = compiler
    ? parseRecoveryConfig(await compiler.compile(instructions))
    : defaultRecoveryConfig;
  return {
    description: instructions,
    config,
    requiresReview: true,
    provenance: compiler ? 'compiler_proposal' : 'template_defaults',
    explanation: compiler
      ? 'Validated proposal; review before enabling.'
      : 'Default recovery settings. The description is stored, but has not been interpreted by an AI model.',
  };
}
