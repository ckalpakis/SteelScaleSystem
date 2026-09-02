export interface TwilioVoiceStatusEvent {
  callSid: string;
  callStatus: string;
  from: string;
  to: string;
  answeredBy?: string;
  durationSeconds: number;
  rawPayload: Record<string, string>;
}
