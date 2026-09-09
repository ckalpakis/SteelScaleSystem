import type { EventHandler } from '../events/router.js';
import { eventTypes } from '../events/contracts.js';
import { audit } from '../workforce/audit/service.js';
import { enqueueRun } from './service.js';
import { subjectTypes, parseDefinition } from './contracts.js';
import { WorkforceError } from '../workforce/shared.js';

export const agentRuntimeHandler: EventHandler = {
  id: 'agent-runtime.v1',
  enabled: () => process.env.AGENT_RUNTIME_ENABLED === 'true',
  types: eventTypes as EventHandler['types'],
  async handle(tx, event, now) {
    if (process.env.AGENT_RUNTIME_ENABLED !== 'true') return;
    // Agent-origin CRM mutations cannot recursively launch more agent runs.
    if (event.source.system === 'steel_scale_agent' || event.actor.startsWith('agent:')) return;
    const agents = await tx.workforceAgent.findMany({
      where: { organizationId: event.organizationId, kind: 'universal', enabled: true },
      orderBy: { id: 'asc' },
      take: 50,
    });
    for (const agent of agents) {
      const trigger = await tx.agentTrigger.findFirst({
        where: {
          organizationId: event.organizationId,
          eventType: event.type,
          version: { agentId: agent.id, number: agent.configVersion },
        },
      });
      if (!trigger) continue;
      // Saturation is visible and terminal for this notification, not an unbounded retry.
      const count = await tx.agentRun.count({
        where: {
          organizationId: event.organizationId,
          createdAt: { gte: new Date(now.getTime() - 86400000) },
        },
      });
      if (count >= 500) {
        await audit(
          tx,
          event.organizationId,
          'agent-router',
          'agent.trigger_rate_limited',
          event.id,
          { agentId: agent.id },
        );
        continue;
      }
      // A capped agent must not prevent other handlers from receiving the event.
      const version = await tx.agentVersion.findFirstOrThrow({
        where: { organizationId: event.organizationId, id: trigger.versionId },
      });
      const config = parseDefinition(version.definition);
      if (
        (await tx.agentRun.count({
          where: {
            organizationId: event.organizationId,
            agentId: agent.id,
            createdAt: { gte: new Date(now.getTime() - 86400000) },
          },
        })) >= config.limits.maxRunsPerDay
      ) {
        await audit(
          tx,
          event.organizationId,
          'agent-router',
          'agent.trigger_rate_limited',
          event.id,
          { agentId: agent.id },
        );
        continue;
      }
      const direct =
        event.entity.id && subjectTypes.some((t) => t === event.entity.type)
          ? event.entity.id
          : undefined;
      const subject = await tx.crmRecord.findFirst({
        where: {
          organizationId: event.organizationId,
          archivedAt: null,
          ...(direct
            ? { id: direct }
            : {
                id: { in: event.relatedRecordIds ?? [] },
                entityType: { in: config.eligibility.entityTypes },
              }),
        },
        orderBy: { id: 'asc' },
      });
      if (!subject) {
        await audit(
          tx,
          event.organizationId,
          'agent-router',
          'agent.trigger_subject_unavailable',
          event.id,
          { agentId: agent.id },
        );
        continue;
      }
      try {
        await enqueueRun(
          tx,
          event.organizationId,
          agent.id,
          subject.id,
          `event:${event.id}`,
          {
            type: event.type,
            source: event.source.system,
            eventId: event.id,
            occurredAt: event.occurredAt,
            data: Object.fromEntries(
              Object.entries(event.data).filter(([key]) =>
                [
                  'status',
                  'previousStatus',
                  'amountMinor',
                  'currency',
                  'dueAt',
                  'fromStageId',
                  'toStageId',
                ].includes(key),
              ),
            ),
          },
          now,
          event.id,
          event.correlationId ?? undefined,
        );
      } catch (error) {
        if (!(error instanceof WorkforceError)) throw error;
        await audit(tx, event.organizationId, 'agent-router', 'agent.trigger_blocked', event.id, {
          agentId: agent.id,
          code: error.code,
        });
      }
    }
  },
};
