import { hash, type Transaction, WorkforceError } from '../workforce/shared.js';
import { audit } from '../workforce/audit/service.js';
export function isOptOut(body: string) {
  const text = body.normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'");
  return (
    /^(?:stop|stopall|unsubscribe|cancel|end|quit|revoke)[.!\s]*$/.test(text.trim()) ||
    /\b(stop|unsubscribe|opt[ -]?out|remove me|do not (?:text|contact|call|email)|don't (?:text|contact|call|email)|leave me alone|no more (?:texts|messages|emails))\b/.test(
      text,
    )
  );
}
export function address(channel: string, value: string) {
  const result = value.trim().normalize('NFKC');
  if (channel === 'sms' && /^\+[1-9]\d{7,14}$/.test(result)) return result;
  if (channel === 'email' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result) && result.length <= 254)
    return result.toLowerCase();
  throw new WorkforceError(400, 'invalid_communication_address');
}
export async function suppress(
  tx: Transaction,
  organizationId: string,
  contactId: string,
  reason: string,
) {
  const contact = await tx.contact.findFirstOrThrow({ where: { organizationId, id: contactId } });
  await tx.contact.update({
    where: { organizationId_id: { organizationId, id: contactId } },
    data: { doNotContact: true },
  });
  await tx.crmRecord.update({
    where: { organizationId_id: { organizationId, id: contactId } },
    data: { version: { increment: 1 } },
  });
  await tx.recoveryConsent.updateMany({
    where: { organizationId, contactId },
    data: { granted: false, evidence: reason, recordedBy: 'communication-safety' },
  });
  for (const [channel, value] of [
    ['sms', contact.phone],
    ['email', contact.email],
  ]) {
    if (!value || !channel) continue;
    let normalized: string;
    try {
      normalized = address(channel, value);
    } catch {
      continue;
    }
    const identity = { organizationId, channel, addressHash: hash(normalized) };
    await tx.communicationSuppression.upsert({
      where: { organizationId_channel_addressHash: identity },
      create: { ...identity, reason },
      update: {},
    });
  }
  await audit(tx, organizationId, 'communication-safety', 'communication.opt_out', contactId, {
    reason,
  });
}
export async function assertContactAllowed(
  tx: Transaction,
  organizationId: string,
  contactId: string,
  channel: string,
  requireConsent = true,
) {
  const contact = await tx.contact.findFirst({
    where: {
      organizationId,
      id: contactId,
      record: { archivedAt: null },
      organization: { active: true },
    },
    include: { organization: { select: { legacyClientId: true } } },
  });
  if (!contact) throw new WorkforceError(404, 'communication_contact_unavailable');
  if (contact.doNotContact) throw new WorkforceError(403, 'contact_opted_out');
  const destination = address(channel, (channel === 'sms' ? contact.phone : contact.email) ?? '');
  if (
    channel === 'sms' &&
    contact.organization.legacyClientId &&
    (await tx.smsConversation.findFirst({
      where: {
        clientId: contact.organization.legacyClientId,
        customerNumber: destination,
        status: 'opted_out',
      },
    }))
  )
    throw new WorkforceError(403, 'legacy_contact_opted_out');
  if (
    await tx.contact.findFirst({
      where: {
        organizationId,
        doNotContact: true,
        ...(channel === 'sms'
          ? { phone: destination }
          : { email: { equals: destination, mode: 'insensitive' } }),
      },
    })
  )
    throw new WorkforceError(403, 'address_suppressed');
  if (
    await tx.communicationSuppression.findUnique({
      where: {
        organizationId_channel_addressHash: {
          organizationId,
          channel,
          addressHash: hash(destination),
        },
      },
    })
  )
    throw new WorkforceError(403, 'address_suppressed');
  // Reuse the existing explicit channel-consent journal instead of duplicating consent truth.
  if (
    requireConsent &&
    !(
      await tx.recoveryConsent.findUnique({
        where: { organizationId_contactId_channel: { organizationId, contactId, channel } },
      })
    )?.granted
  )
    throw new WorkforceError(403, 'consent_required');
  return { contact, destination };
}
