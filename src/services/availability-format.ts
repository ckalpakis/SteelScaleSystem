export function spokenAvailabilitySlots(slots: string[], timezone: string): string[] {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return slots.flatMap((slot) => {
    const date = new Date(slot);
    return Number.isNaN(date.valueOf()) ? [] : [formatter.format(date)];
  });
}
