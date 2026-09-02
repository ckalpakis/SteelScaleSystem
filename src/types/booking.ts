import type { BookingSource } from '@prisma/client';

export interface InternalBookingRequest {
  clientId: string;
  source: BookingSource;
  customerName: string;
  phoneNumber: string;
  address?: string;
  service: string;
  preferredTime: string;
  providerCallId?: string;
  providerRequestId?: string;
}

export interface InternalBookingResult {
  accepted: boolean;
  bookingAttemptId: string;
  message: string;
  destination?: 'zapier' | 'ghl_fallback';
  fallbackUsed: boolean;
  manualFollowUpRequired: boolean;
}
