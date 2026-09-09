import { randomUUID } from 'node:crypto';
import { requireDemoTestDatabase } from '../demo-engine/test-database.js';
import { provisionOrganization, authenticate } from '../workforce/tenancy/service.js';
import { CrmService } from '../crm/service.js';
import { KnowledgeService } from '../knowledge/service.js';
import { RecoveryService } from '../recovery/service.js';
import { exampleConfig } from '../recovery/contracts.js';
import type { Database } from '../workforce/shared.js';

/** Fictional local-only data, shared by database and browser verification. */
export async function workspaceFixture(db: Database, name = 'Northline Service Group (test)') {
  requireDemoTestDatabase();
  const org = await provisionOrganization(
    db,
    { name, ownerSubject: `workspace-test:${randomUUID()}` },
    'test',
  );
  const principal = await authenticate(db, `Bearer ${org.token}`);
  const crm = new CrmService(db, principal);
  const knowledge = new KnowledgeService(db, principal);
  const recovery = new RecoveryService(db, principal);
  const source = await knowledge.source({ name: 'Approved customer messages (test)' });
  const config = exampleConfig();
  config.model = 'test-model';
  const knowledgeEntries = [];
  for (const item of config.knowledge) {
    const entry = await knowledge.save({
      sourceId: source.id,
      category: 'faq',
      audience: 'public',
      title: item.topic,
      question: `What is the approved ${item.topic} message?`,
      content: item.text,
      facts: { answer: item.text },
    });
    await knowledge.approve(entry.entry.id, {
      expectedRevision: entry.entry.revision,
      versionId: entry.version.id,
      reviewed: true,
    });
    item.versionId = entry.version.id;
    item.approved = true;
    knowledgeEntries.push(entry);
  }
  const program = await recovery.configure({
    config,
    connectionId: null,
    expectedVersion: 0,
    reviewed: true,
  });
  const pipeline = await crm.create('pipelines', { name: 'Service proposals' });
  const stage = await crm.create('stages', {
    name: 'Proposal sent',
    pipelineId: pipeline.id,
    position: 0,
  });
  const organizationId = org.organization.id;
  async function addCase(
    customer = 'Alex Morgan',
    title = 'Annual service agreement',
    currency = 'USD',
  ) {
    const contact = await crm.create('contacts', { name: customer, phone: '+12025550197' });
    const opportunity = await crm.create('opportunities', {
      title,
      customerId: contact.id,
      pipelineId: pipeline.id,
      stageId: stage.id,
      currency: 'USD',
      amountMinor: 480000,
      lastActivityAt: new Date(Date.now() - 7 * 86400000).toISOString(),
    });
    const recoveryCase = await recovery.enroll(opportunity.id);
    // Multi-currency reporting fixture: enrollment above intentionally used valid program currency.
    if (currency !== 'USD')
      await db.opportunity.update({ where: { id: opportunity.id }, data: { currency } });
    return { contact, opportunity, recoveryCase };
  }
  return {
    organizationId,
    principal,
    token: org.token,
    crm,
    knowledge,
    source,
    knowledgeEntries,
    recovery,
    config,
    program,
    pipeline,
    stage,
    addCase,
  };
}
