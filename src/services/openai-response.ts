/** Parse the actual REST response; output_text is an SDK convenience, not a REST field. */
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function responseText(raw: unknown): string {
  const output = record(raw).output;
  if (!Array.isArray(output)) return '';
  return output
    .flatMap((item: unknown) => {
      const message = record(item);
      if (message.type !== 'message' || !Array.isArray(message.content)) return [];
      return message.content.flatMap((part: unknown) => {
        const block = record(part);
        return block.type === 'output_text' && typeof block.text === 'string' ? [block.text] : [];
      });
    })
    .join('\n');
}
