import type { EventHandler } from '../events/router.js';
import { parseConfig } from './contracts.js';
import { baseEligibility, ensureHandoff, loadCase, pauseCase } from './lifecycle.js';
import { enroll, startCase } from './orchestrator.js';
import { safetyIntent } from './decisions.js';
import { recordOutcome } from './attribution.js';
import { audit } from '../workforce/audit/service.js';
import { WorkforceError } from '../workforce/shared.js';

export const universalRecoveryHandler: EventHandler = {
  id: 'universal-revenue-recovery.v1',
  enabled: () => process.env.REVENUE_RECOVERY_ENABLED === 'true',
  types: [
    'estimate.sent',
    'estimate.accepted',
    'estimate.declined',
    'opportunity.created',
    'opportunity.updated',
    'opportunity.stage_changed',
    'opportunity.won',
    'opportunity.lost',
    'customer.message_received',
    'message.created',
    'appointment.booked',
    'appointment.cancelled',
    'contact.updated',
  ],
  async handle(tx, event, now) {
    const organizationId = event.organizationId,
      program = await tx.recoveryProgram.findUnique({
        where: { organizationId },
        include: { agent: true, runtimeVersion: true },
      });
    if (!program) return;
    if (event.type === 'customer.message_received') {
      const message = await tx.message.findFirst({
        where: { organizationId, id: event.entity.id ?? '', direction: 'inbound' },
        include: { conversation: true },
      });
      if (!message) return;
      const critical = safetyIntent(message.body);
      if (critical === 'opt_out') {
        await tx.contact.update({
          where: { organizationId_id: { organizationId, id: message.conversation.contactId } },
          data: { doNotContact: true },
        });
        await tx.crmRecord.update({
          where: { organizationId_id: { organizationId, id: message.conversation.contactId } },
          data: { version: { increment: 1 } },
        });
        await tx.recoveryConsent.updateMany({
          where: { organizationId, contactId: message.conversation.contactId },
          data: { granted: false, evidence: 'Inbound opt-out', recordedBy: 'recovery-safety' },
        });
        await audit(
          tx,
          organizationId,
          'recovery-safety',
          'recovery.opt_out',
          message.conversation.contactId,
          { messageId: message.id },
        );
      }
      const rows = await tx.recoveryCase.findMany({
        where: { organizationId, contactId: message.conversation.contactId },
      });
      for (const initial of rows) {
        if (initial.latestResponseId === message.id) continue;
        const row = await loadCase(tx, organizationId, initial.id);
        await pauseCase(
          tx,
          row,
          critical === 'opt_out'
            ? 'opted_out'
            : row.state === 'human_owned'
              ? 'human_owned'
              : critical
                ? 'handoff'
                : 'awaiting_classification',
          'customer_response',
          now,
        );
        const engaged =
          rows.length === 1 &&
          row.state !== 'human_owned' &&
          row.firstDeliveredAt &&
          message.occurredAt >= row.firstDeliveredAt &&
          message.occurredAt <= now
            ? message.occurredAt
            : null;
        await tx.recoveryCase.update({
          where: { organizationId_id: { organizationId, id: row.id } },
          data: {
            latestResponseId: message.id,
            pendingRunId: null,
            ...(engaged && !row.engagedAt ? { engagedAt: engaged } : {}),
          },
        });
        await ensureHandoff(
          tx,
          row,
          critical ?? 'customer_response',
          critical
            ? 'A safety-sensitive customer reply requires review.'
            : 'Customer replied; follow-up is paused pending classification and employee review.',
          now,
        );
        // Receiving an inbound message never bypasses human ownership or opt-out.
        if (program.agent.enabled && !critical && row.state !== 'human_owned') {
          try {
            await startCase(tx, organizationId, row.id, now, true);
          } catch (error) {
            if (!(error instanceof WorkforceError)) throw error;
            await audit(
              tx,
              organizationId,
              'recovery-safety',
              'recovery.classification_blocked',
              row.id,
              { code: error.code },
            );
          }
        }
      }
      return;
    }
    if (event.type === 'message.created' && !event.actor.startsWith('agent:')) {
      const message = await tx.message.findFirst({
        where: { organizationId, id: event.entity.id ?? '', direction: 'outbound' },
        include: { conversation: true },
      });
      if (message) {
        const rows = await tx.recoveryCase.findMany({
          where: {
            organizationId,
            contactId: message.conversation.contactId,
            state: { in: ['monitoring', 'working', 'awaiting_classification'] },
          },
        });
        for (const initial of rows) {
          const row = await loadCase(tx, organizationId, initial.id);
          await pauseCase(tx, row, 'handoff', 'employee_contact', now);
          await tx.recoveryCase.update({
            where: { organizationId_id: { organizationId, id: row.id } },
            data: { employeeActionAt: now },
          });
          await ensureHandoff(
            tx,
            row,
            'employee_contact',
            'Employee or external CRM sent a message. Follow-up is paused.',
            now,
          );
        }
      }
      return;
    }
    let opportunityId = event.entity.type === 'opportunity' ? event.entity.id : null;
    if (event.entity.type === 'estimate')
      opportunityId =
        (await tx.estimate.findFirst({ where: { organizationId, id: event.entity.id ?? '' } }))
          ?.opportunityId ?? null;
    if (event.entity.type === 'appointment')
      opportunityId =
        (await tx.appointment.findFirst({ where: { organizationId, id: event.entity.id ?? '' } }))
          ?.opportunityId ?? null;
    if (event.type === 'contact.updated') {
      const contact = await tx.contact.findFirst({
        where: { organizationId, id: event.entity.id ?? '' },
      });
      if (contact?.doNotContact)
        for (const row of await tx.recoveryCase.findMany({
          where: { organizationId, contactId: contact.id },
        }))
          await pauseCase(tx, row, 'opted_out', 'opt_out', now);
      return;
    }
    if (!opportunityId) return;
    let record = await tx.recoveryCase.findUnique({
      where: { organizationId_opportunityId: { organizationId, opportunityId } },
    });
    if (
      !record &&
      program.agent.enabled &&
      [
        'estimate.sent',
        'opportunity.stage_changed',
        'opportunity.created',
        'opportunity.updated',
      ].includes(event.type)
    )
      record = await enroll(tx, program, opportunityId, now, new Date(event.occurredAt));
    if (!record) return;
    const row = await loadCase(tx, organizationId, record.id),
      blocked = baseEligibility(parseConfig(program.runtimeVersion.specialization), row);
    if (
      [
        'opportunity.created',
        'opportunity.updated',
        'opportunity.stage_changed',
        'opportunity.won',
        'appointment.booked',
        'appointment.cancelled',
        'opportunity.lost',
      ].includes(event.type)
    )
      await recordOutcome(tx, row, event, now);
    if (
      blocked ||
      ['estimate.accepted', 'estimate.declined', 'appointment.booked'].includes(event.type)
    )
      await pauseCase(
        tx,
        row,
        event.type === 'appointment.booked'
          ? 'appointment_booked'
          : row.opportunity.status === 'won'
            ? 'won'
            : row.opportunity.status === 'lost'
              ? 'lost'
              : 'ineligible',
        blocked ?? event.type,
        now,
      );
  },
};
