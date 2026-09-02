export interface CalendarAvailabilityResult {
  requestedTime: string;
  requestedAvailable: boolean;
  availableSlots: string[];
  timezone: string;
  source: 'ghl' | 'zapier';
}
