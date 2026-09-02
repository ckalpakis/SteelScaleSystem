import { sendSlackMessage } from '../../services/slack-alerts.js';

export interface PipelineAlertInput {
  runId: string;
  clientId: string;
  campaignKey: string;
  source: string;
  status: string;
  discovered: number;
  enriched: number;
  enrichmentFailures: number;
  scored: number;
  qualified: number;
  errors: Array<{ stage: string; message: string }>;
  sourceStale?: boolean;
}

export async function alertImportantPipelineFailure(input: PipelineAlertInput): Promise<boolean> {
  const enrichmentTotal = input.enriched + input.enrichmentFailures;
  const enrichmentFailureRate = enrichmentTotal ? input.enrichmentFailures / enrichmentTotal : 0;
  const reasons: string[] = [];
  if (input.status === 'failed') reasons.push('Lead pipeline failed');
  if (input.errors.some(({ stage }) => stage === 'DISCOVER' || stage === 'INGEST')) {
    reasons.push(`${input.source} ingestion failed`);
  }
  if (enrichmentTotal >= 5 && enrichmentFailureRate > 0.2) {
    reasons.push(`${Math.round(enrichmentFailureRate * 100)}% website enrichment failure`);
  }
  if (input.sourceStale) reasons.push('Real-estate source has not returned listings on schedule');
  if (input.scored > 0 && input.qualified === 0) {
    reasons.push('Scoring job unexpectedly generated zero qualified leads');
  }
  if (!reasons.length) return false;
  return sendSlackMessage(
    [
      ':warning: *Lead Intelligence pipeline alert*',
      `Campaign: ${input.campaignKey}`,
      `Source: ${input.source}`,
      `Run: ${input.runId}`,
      ...reasons.map((reason) => `• ${reason}`),
      `Discovered ${input.discovered} · Enriched ${input.enriched} · Scored ${input.scored} · Qualified ${input.qualified}`,
      ...input.errors.slice(0, 5).map(({ stage, message }) => `${stage}: ${message}`),
    ].join('\n'),
    { clientId: input.clientId, attempted: 'lead_pipeline_alert' },
  );
}
