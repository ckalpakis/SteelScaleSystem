import {
  intents,
  mandatoryHandoffs,
  parseClassification,
  type Intent,
  type RecoveryConfig,
  type RecoveryDecisionValue,
} from './contracts.js';

/** Deterministic safety detectors are additive to model classification, never authorizers. */
export function safetyIntent(text: string): Intent | null {
  const t = text.toLowerCase().normalize('NFKC');
  if (
    /\b(stop|unsubscribe|opt[ -]?out|remove me|do not (?:text|contact|call)|don't (?:text|contact|call)|leave me alone|no more (?:texts|messages))\b/.test(
      t,
    )
  )
    return 'opt_out';
  if (/\b(wrong (?:person|number)|not (?:john|jane|your customer)|you have the wrong)\b/.test(t))
    return 'wrong_person';
  if (
    /\b(lawsuit|lawyer|sue you|legal advice|guarantee.*claim|insurance (?:coverage|representation)|compliance|discrimination)\b/.test(
      t,
    )
  )
    return 'legal_or_compliance';
  if (/\b(angry|furious|scam|harass|rip.?off|idiot)\b/.test(t)) return 'angry_customer';
  if (
    /\b(discount|negotiate|lower (?:the |your )?price|take \$|accept \$|do it for|move forward.*\$)\b/.test(
      t,
    )
  )
    return 'pricing_negotiation';
  return null;
}
/** Offline-only scenario classifier; live ambiguous language uses the configured AI provider. */
export function classifyFixture(text: string): RecoveryDecisionValue {
  const t = text.toLowerCase(),
    guarded = safetyIntent(text);
  const patterns: [Intent, RegExp][] = [
    [
      'not_interested',
      /not interested|no thanks|already (?:bought|hired)|decline|cancel (?:it|my)/,
    ],
    ['financing_question', /financ|interest rate|monthly payment|loan/],
    ['competitor_comparison', /competitor|other (?:company|quote)|another (?:company|quote)/],
    ['price_objection', /expensive|too much|afford|over (?:my |our )?budget/],
    ['needs_spouse_or_partner', /spouse|husband|wife|partner|business co.owner/],
    ['timing', /later|next (?:month|year)|not now|wait|in (?:two|three|six) months/],
    [
      'scheduling_request',
      /schedule|calendar|appointment|book|available.*(?:monday|tuesday|friday)/,
    ],
    [
      'information_request',
      /warranty|what.*include|explain|more (?:details|information)|how long|service details/,
    ],
    ['interested', /interested|let.s (?:go|proceed)|ready|yes|move forward/],
  ];
  const intent = guarded ?? patterns.find(([, r]) => r.test(t))?.[0] ?? 'unknown';
  return {
    intent,
    interest_level:
      intent === 'interested' ? 'high' : intent === 'not_interested' ? 'none' : 'unknown',
    recommended_action: 'handoff',
    human_required: true,
    reason: `Scenario classification: ${intent}.`,
    next_followup_at: null,
    message_if_allowed: null,
  };
}
export function normalizeDecision(
  config: RecoveryConfig,
  raw: unknown,
  inbound: string | null,
  attempts: number,
  now: Date,
): RecoveryDecisionValue {
  const proposed = parseClassification(raw);
  const intent = inbound ? (safetyIntent(inbound) ?? proposed.intent) : 'unknown';
  const stop = intent === 'opt_out' || intent === 'not_interested';
  const forbidden =
    mandatoryHandoffs.includes(intent) ||
    config.restrictedTopics.includes(intent) ||
    config.handoffConditions.includes(intent);
  const topic = inbound ? intent : attempts ? 'followup' : 'initial';
  const knowledge = config.knowledge.find((k) => k.topic === topic && k.approved);
  // No model-authored company facts or dates ever reach a dispatch. Text is an exact approved
  // organization knowledge entry. Replies always end autonomous follow-up and go to a person.
  const text =
    knowledge && (!inbound || (!forbidden && config.allowedObjections.includes(intent)))
      ? knowledge.text
      : null;
  return {
    intent,
    interest_level: proposed.interest_level,
    recommended_action: inbound
      ? stop
        ? 'stop'
        : 'handoff'
      : text && config.mode !== 'ADVISORY'
        ? 'send_message'
        : 'handoff',
    human_required: !stop,
    reason: inbound
      ? `Customer response classified as ${intent}; autonomous follow-up paused.`
      : config.mode === 'ADVISORY'
        ? 'Advisory recommendation only; no AI message may be queued.'
        : text
          ? 'Approved follow-up proposed; runtime approval required.'
          : 'No approved follow-up text available.',
    next_followup_at:
      inbound || config.mode === 'ADVISORY' || attempts >= config.maximumAttempts
        ? null
        : new Date(
            now.getTime() +
              (attempts
                ? (config.cadenceMinutes[
                    Math.min(attempts - 1, config.cadenceMinutes.length - 1)
                  ] ?? 60)
                : config.delayMinutes) *
                60000,
          ).toISOString(),
    message_if_allowed: stop || (forbidden && inbound) ? null : text,
  };
}
export const emptyClassification = (): RecoveryDecisionValue => ({
  intent: 'unknown',
  interest_level: 'unknown',
  recommended_action: 'wait',
  human_required: true,
  reason: 'Scheduled evaluation.',
  next_followup_at: null,
  message_if_allowed: null,
});
export const intentNames: readonly string[] = intents;
