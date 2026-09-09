import { audit } from '../workforce/audit/service.js';
import { recordRecoveryDispatch } from '../communications/ledger.js';
import { integer, keys, object, string, uuid, WorkforceError } from '../workforce/shared.js';
import { RecoveryService } from './service.js';
import { baseEligibility, ensureHandoff, loadCase, messageGuard, pauseCase } from './lifecycle.js';
import { parseConfig, one } from './contracts.js';

export class RecoveryHandoffService extends RecoveryService {
  act(id: string, raw: unknown) {
    uuid(id);
    const v = object(raw);
    keys(v, ['action', 'expectedRevision', 'message', 'channel', 'requestKey']);
    const action = one(v.action, ['take_over', 'respond', 'return_to_ai', 'close']),
      expected = integer(v.expectedRevision, 1, 2147483647);
    return this.tx(async (tx, organizationId) => {
      const handoff = await tx.recoveryHandoff.findFirst({ where: { organizationId, id } });
      if (!handoff) throw new WorkforceError(404, 'recovery_handoff_not_found');
      const memberId = this.principal.actor.startsWith('member:')
        ? this.principal.actor.slice(7)
        : null;
      if (!memberId) throw new WorkforceError(403, 'member_required');
      if (
        !['owner', 'admin'].includes(this.principal.role ?? '') &&
        handoff.assignedMemberId !== memberId
      )
        throw new WorkforceError(403, 'handoff_not_assigned');
      if (handoff.revision !== expected) throw new WorkforceError(409, 'handoff_revision_conflict');
      const row = await loadCase(tx, organizationId, handoff.caseId),
        config = parseConfig(row.program.runtimeVersion.specialization),
        now = new Date();
      if (action === 'respond') {
        if (handoff.status !== 'owned' || handoff.assignedMemberId !== memberId)
          throw new WorkforceError(409, 'take_over_before_responding');
        const body = string(v.message, 1000),
          channel = one(v.channel, ['sms', 'email']),
          requestKey = string(v.requestKey, 100);
        const prior = await tx.recoveryDispatch.findUnique({
          where: {
            organizationId_requestKey: { organizationId, requestKey: `human:${requestKey}` },
          },
        });
        if (prior) {
          if (
            prior.body !== body ||
            prior.caseId !== row.id ||
            prior.channel !== channel ||
            prior.actor !== this.principal.actor
          )
            throw new WorkforceError(409, 'response_idempotency_conflict');
          return prior;
        }
        const blocked = await messageGuard(tx, row, channel, now, { human: true });
        if (blocked) throw new WorkforceError(409, blocked);
        const dispatch = await tx.recoveryDispatch.create({
          data: {
            organizationId,
            caseId: row.id,
            requestKey: `human:${requestKey}`,
            body,
            channel,
            actor: this.principal.actor,
            caseRevision: row.revision,
            runtimeVersionId: row.program.runtimeVersionId,
          },
        });
        await tx.recoveryCase.update({
          where: { organizationId_id: { organizationId, id: row.id } },
          data: { employeeActionAt: now },
        });
        await audit(
          tx,
          organizationId,
          this.principal.actor,
          'recovery.human_response_queued',
          dispatch.id,
          { caseId: row.id, deliveryStatus: 'not_sent' },
        );
        if (process.env.COMMUNICATIONS_ENABLED === 'true')
          await recordRecoveryDispatch(tx, organizationId, dispatch.id);
        return dispatch;
      }
      if (action === 'return_to_ai') {
        const base = baseEligibility(config, row);
        if (base) throw new WorkforceError(409, base);
        if (row.attempts >= config.maximumAttempts) throw new WorkforceError(409, 'attempt_limit');
        if (
          await tx.recoveryDispatch.findFirst({
            where: {
              organizationId,
              caseId: row.id,
              status: { in: ['pending', 'dispatching', 'unknown'] },
            },
          })
        )
          throw new WorkforceError(409, 'resolve_delivery_before_resuming');
        await tx.recoveryCase.update({
          where: { organizationId_id: { organizationId, id: row.id } },
          data: {
            state: 'monitoring',
            reason: null,
            revision: { increment: 1 },
            pendingRunId: null,
            nextDueAt: new Date(
              now.getTime() +
                Math.max(
                  config.employeeQuietMinutes,
                  config.cadenceMinutes[Math.max(0, row.attempts - 1)] ?? config.delayMinutes,
                ) *
                  60000,
            ),
          },
        });
      } else {
        // Closing a handoff is not consent to restart automation.
        await pauseCase(
          tx,
          row,
          action === 'close' ? 'closed' : 'human_owned',
          action === 'close' ? 'handoff_closed' : 'human_takeover',
          now,
        );
        if (action === 'take_over') {
          await tx.recoveryCase.update({
            where: { organizationId_id: { organizationId, id: row.id } },
            data: { employeeActionAt: now },
          });
          // A shared conversation/contact cannot have another opportunity send over a person.
          for (const other of await tx.recoveryCase.findMany({
            where: {
              organizationId,
              contactId: row.contactId,
              NOT: { id: row.id },
              state: { in: ['monitoring', 'working', 'awaiting_classification'] },
            },
          })) {
            await pauseCase(tx, other, 'handoff', 'contact_human_controlled', now);
            await ensureHandoff(
              tx,
              await loadCase(tx, organizationId, other.id),
              'contact_human_controlled',
              'Another opportunity for this contact is under employee control.',
              now,
            );
          }
        }
      }
      const updated = await tx.recoveryHandoff.update({
        where: { organizationId_id: { organizationId, id } },
        data: {
          status: action === 'return_to_ai' ? 'returned' : action === 'close' ? 'closed' : 'owned',
          ...(action === 'take_over' ? { assignedMemberId: memberId } : {}),
          revision: { increment: 1 },
        },
      });
      await audit(tx, organizationId, this.principal.actor, `recovery.handoff_${action}`, id, {
        caseId: row.id,
      });
      return updated;
    }, 'crm:write');
  }
}
