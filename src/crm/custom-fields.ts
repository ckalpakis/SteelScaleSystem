import { json, WorkforceError, type Transaction } from '../workforce/shared.js';
import { validateFieldValue, type EntityType } from './validation.js';

export async function applyCustomFields(
  tx: Transaction,
  organizationId: string,
  recordId: string,
  entityType: EntityType,
  supplied: Record<string, unknown> | undefined,
  creating: boolean,
): Promise<void> {
  const definitions = await tx.customFieldDefinition.findMany({
    where: { organizationId, entityType, archivedAt: null },
  });
  const values = supplied ?? {};
  const byId = new Map(definitions.map((field) => [field.id, field]));
  for (const [id, value] of Object.entries(values)) {
    const field = byId.get(id);
    if (!field) throw new WorkforceError(400, 'custom_field_not_defined_for_record');
    if (value === null) {
      if (field.required) throw new WorkforceError(400, 'required_custom_field');
      await tx.customFieldValue.deleteMany({
        where: { organizationId, recordId, definitionId: id },
      });
    } else {
      validateFieldValue(field, value);
      if (field.required && (value === '' || (Array.isArray(value) && !value.length)))
        throw new WorkforceError(400, 'required_custom_field');
      await tx.customFieldValue.upsert({
        where: {
          organizationId_definitionId_recordId: { organizationId, definitionId: id, recordId },
        },
        create: {
          organizationId,
          definitionId: id,
          recordId,
          entityType,
          fieldType: field.fieldType,
          value: json(value),
        },
        update: { value: json(value) },
      });
    }
  }
  if (
    creating &&
    definitions.some(
      (field) => field.required && (values[field.id] === undefined || values[field.id] === null),
    )
  ) {
    throw new WorkforceError(400, 'required_custom_field');
  }
}
