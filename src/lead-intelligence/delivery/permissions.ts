import { ConsentStatus } from '@prisma/client';

import { db } from '../../db/client.js';

export async function recordLeadContactPermission(input: {
  leadId: string;
  contactableProspect?: boolean;
  manualCallCandidate?: boolean;
  smsConsent?: ConsentStatus;
  doNotContact?: boolean;
  suppressed?: boolean;
  consentSource?: string;
  recordedAt?: Date;
  updatedBy?: string;
}) {
  const existing = await db.leadContactPermission.findUnique({ where: { leadId: input.leadId } });
  const smsConsent = input.smsConsent ?? existing?.smsConsent ?? ConsentStatus.unknown;
  const doNotContact = input.doNotContact ?? existing?.doNotContact ?? false;
  const suppressed = input.suppressed ?? existing?.suppressed ?? false;
  const smsEligible =
    smsConsent === ConsentStatus.granted &&
    !doNotContact &&
    !suppressed &&
    Boolean(input.consentSource ?? existing?.consentSource);
  const data = {
    contactableProspect: input.contactableProspect ?? existing?.contactableProspect ?? true,
    manualCallCandidate: input.manualCallCandidate ?? existing?.manualCallCandidate ?? false,
    smsConsent,
    smsEligible,
    doNotContact,
    suppressed,
    consentSource: input.consentSource ?? existing?.consentSource,
    consentRecordedAt:
      smsConsent === ConsentStatus.granted
        ? (input.recordedAt ?? existing?.consentRecordedAt ?? new Date())
        : existing?.consentRecordedAt,
    optedOutAt:
      smsConsent === ConsentStatus.opted_out
        ? (input.recordedAt ?? new Date())
        : smsConsent === ConsentStatus.granted
          ? null
          : existing?.optedOutAt,
    updatedBy: input.updatedBy,
  };
  return db.leadContactPermission.upsert({
    where: { leadId: input.leadId },
    create: { leadId: input.leadId, ...data },
    update: data,
  });
}
