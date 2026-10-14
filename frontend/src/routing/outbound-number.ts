// Rebuild from the originally dialed number, never from a previously rewritten URI.
export function outboundNumber(dialed: string, prefix: string, strip: boolean, prepend = ''): string | null {
  if (!prefix || !dialed.startsWith(prefix)) return null;
  return prepend + (strip ? dialed.slice(prefix.length) : dialed);
}
