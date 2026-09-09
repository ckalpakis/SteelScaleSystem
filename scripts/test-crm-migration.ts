/** Upgrade rehearsal. Requires a completely empty, disposable loopback test database. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { requireDemoTestDatabase } from '../src/demo-engine/test-database.js';

async function main() {
  requireDemoTestDatabase();
  const db = new PrismaClient();
  const workspace = await mkdtemp(path.join(tmpdir(), 'steel-scale-crm-upgrade-'));
  try {
    const tables = await db.$queryRaw<
      Array<{ tablename: string }>
    >`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
    assert.equal(
      tables.length,
      0,
      'This test requires an EMPTY disposable database; it never resets or drops a database.',
    );
    await cp('prisma/schema.prisma', path.join(workspace, 'schema.prisma'));
    await mkdir(path.join(workspace, 'migrations'));
    const boundary = '20260908150000_canonical_crm';
    for (const migration of await readdir('prisma/migrations')) {
      if (migration === 'migration_lock.toml' || migration < boundary)
        await cp(
          path.join('prisma/migrations', migration),
          path.join(workspace, 'migrations', migration),
          { recursive: true },
        );
    }
    function deploy(schema: string) {
      const result = spawnSync(
        process.execPath,
        ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', schema],
        {
          env: { ...process.env, DOTENV_CONFIG_PATH: '/dev/null' },
          encoding: 'utf8',
          timeout: 60000,
        },
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
    deploy(path.join(workspace, 'schema.prisma'));
    const organizationId = randomUUID();
    const memberId = randomUUID();
    const contactId = randomUUID();
    const opportunityId = randomUUID();
    const eventId = randomUUID();
    const connectionId = randomUUID();
    const client = await db.client.create({
      data: {
        businessName: 'Migration sentinel',
        phoneNumber: '+12025550199',
        timezone: 'UTC',
        services: ['Consultation'],
      },
    });
    const legacySnapshot = JSON.stringify(client);
    await db.$executeRaw`INSERT INTO "Organization" (id, name, "legacyClientId") VALUES (${organizationId}::uuid, 'Upgrade sentinel', ${client.id}::uuid)`;
    await db.$executeRaw`INSERT INTO "OrganizationMembership" (id, "organizationId", subject, role) VALUES (${memberId}::uuid, ${organizationId}::uuid, 'migration-owner', 'owner')`;
    await db.$executeRaw`INSERT INTO "WorkforceIntegration" (id, "organizationId", name, provider) VALUES (${connectionId}::uuid, ${organizationId}::uuid, 'Zapier sentinel', 'zapier')`;
    // One synthetic/internal source and one real integration source exercise both backfills.
    await db.$executeRaw`INSERT INTO "WorkforceCustomer" (id, "organizationId", source, "externalId", name, "sourceOccurredAt", "updatedAt") VALUES (${contactId}::uuid, ${organizationId}::uuid, 'internal', 'c-old', 'Retained customer', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
    await db.$executeRaw`INSERT INTO "WorkforceOpportunity" (id, "organizationId", "customerId", source, "externalId", title, status, "amountMinor", currency, "lastActivityAt", "sourceOccurredAt", "updatedAt") VALUES (${opportunityId}::uuid, ${organizationId}::uuid, ${contactId}::uuid, ${connectionId}, 'o-old', 'Retained opportunity', 'estimate_sent', 12345, 'USD', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
    await db.$executeRaw`INSERT INTO "WorkforceEvent" (id, "organizationId", source, "externalId", type, payload, "payloadHash", "occurredAt") VALUES (${eventId}::uuid, ${organizationId}::uuid, ${connectionId}, 'evt-old', 'opportunity.upserted', '{"data":{"externalId":"o-old"}}'::jsonb, 'sentinel', CURRENT_TIMESTAMP)`;
    const before = await db.$queryRaw<
      Array<{ contact: unknown; opportunity: unknown; event: unknown; connection: unknown }>
    >`SELECT (SELECT to_jsonb(c) FROM "WorkforceCustomer" c WHERE id = ${contactId}::uuid) contact, (SELECT to_jsonb(o) FROM "WorkforceOpportunity" o WHERE id = ${opportunityId}::uuid) opportunity, (SELECT to_jsonb(e) FROM "WorkforceEvent" e WHERE id = ${eventId}::uuid) event, (SELECT to_jsonb(x) FROM "WorkforceIntegration" x WHERE id = ${connectionId}::uuid) connection`;
    deploy('prisma/schema.prisma');
    const after = await db.$queryRaw<
      typeof before
    >`SELECT (SELECT to_jsonb(c) - ARRAY['companyId','entityType','firstName','lastName'] FROM "WorkforceCustomer" c WHERE id = ${contactId}::uuid) contact, (SELECT to_jsonb(o) - ARRAY['companyId','entityType','pipelineId','stageId'] FROM "WorkforceOpportunity" o WHERE id = ${opportunityId}::uuid) opportunity, (SELECT to_jsonb(e) - ARRAY['actor','causationId','connectionId','correlationId','entityId','entityType','externalRecordId','externalRecordType','metadata','provider','recordId','recordType'] FROM "WorkforceEvent" e WHERE id = ${eventId}::uuid) event, (SELECT to_jsonb(x) - ARRAY['externalAccountId','webhookMapping'] FROM "WorkforceIntegration" x WHERE id = ${connectionId}::uuid) connection`;
    assert.deepEqual(
      after,
      before,
      'Existing CRM values, source IDs, statuses, amounts, events and provider values must remain unchanged.',
    );
    assert.equal(
      JSON.stringify(await db.client.findUnique({ where: { id: client.id } })),
      legacySnapshot,
    );
    assert.equal(await db.crmRecord.count({ where: { organizationId } }), 2);
    assert.equal(await db.externalRecordMapping.count({ where: { organizationId } }), 2);
    assert.equal(await db.businessEventLink.count({ where: { organizationId, eventId } }), 2);
    const historicalEvent = await db.businessEvent.findUniqueOrThrow({ where: { id: eventId } });
    assert.equal(historicalEvent.version, 1);
    assert.equal(historicalEvent.correlationId, null);
    assert.equal(historicalEvent.provider, null);
    assert.equal(await db.eventIntake.count(), 0);
    assert.equal(await db.backgroundTask.count(), 0);
    assert.equal(await db.eventDelivery.count(), 0);
    assert.equal(await db.webhookEndpoint.count(), 0);
    assert.equal(await db.outboundDelivery.count(), 0);
    assert.equal(await db.agentVersion.count(), 0);
    assert.equal(await db.agentRun.count(), 0);
    assert.equal(await db.agentAction.count(), 0);
    assert.equal(await db.agentBlueprint.count(), 0);
    assert.equal(await db.agentBlueprintVersion.count(), 0);
    assert.equal(await db.recoveryProgram.count(), 0);
    assert.equal(await db.recoveryCase.count(), 0);
    assert.equal(await db.recoveryDispatch.count(), 0);
    assert.equal(await db.recoveryAttribution.count(), 0);
    assert.equal(await db.knowledgeSource.count(), 0);
    assert.equal(await db.knowledgeDocument.count(), 0);
    assert.equal(await db.knowledgeEntry.count(), 0);
    assert.equal(await db.knowledgeVersion.count(), 0);
    assert.equal(await db.communicationAccount.count(), 0);
    assert.equal(await db.communicationDelivery.count(), 0);
    assert.equal(await db.communicationAttempt.count(), 0);
    assert.equal(await db.communicationSuppression.count(), 0);
    assert.equal(
      (await db.organization.findUniqueOrThrow({ where: { id: organizationId } }))
        .knowledgeRevision,
      0,
    );
    assert.equal(
      (await db.organization.findUniqueOrThrow({ where: { id: organizationId } })).active,
      true,
    );
    const member = await db.organizationMember.findUniqueOrThrow({
      where: { organizationId_id: { organizationId, id: memberId } },
      include: { user: true },
    });
    assert.equal(member.user?.externalSubject, 'migration-owner');
    assert.equal(
      (
        await db.externalRecordMapping.findFirstOrThrow({
          where: { organizationId, internalEntityId: opportunityId },
        })
      ).connectionId,
      connectionId,
    );
    console.log(
      'PASS CRM/events upgrade: all migrations, populated legacy/client and workforce row preservation, canonical IDs, users, mappings, timeline backfill, unchanged historical event payloads.',
    );
  } finally {
    await db.$disconnect();
  }
}
main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
