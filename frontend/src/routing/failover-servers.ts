import type { ApplicationDestination } from '../api/client';

export type FailoverServerOption = {
  id: number;
  name: string;
  destination: string;
  ip: string;
  port: number;
  groupName: string;
  state: number;
};

// One option per server, not per group. Reusing one member must not copy its whole group.
export function failoverServerOptions(groups: ApplicationDestination[], selected?: ApplicationDestination): FailoverServerOption[] {
  if (!selected || selected.conflicts.length) return [];
  const alreadyUsed = new Set(selected.destinations.map(member => member.destination));
  const servers = new Map<string, FailoverServerOption>();
  for (const group of groups) {
    if (group.conflicts.length) continue;
    for (const member of group.destinations) {
      if (!member.ip || !member.port || member.port < 1 || member.port > 65535 || alreadyUsed.has(member.destination)) continue;
      if (!servers.has(member.destination)) servers.set(member.destination, {
        id: member.id, name: member.description?.trim() || group.name,
        destination: member.destination, ip: member.ip, port: member.port, groupName: group.name, state: member.state,
      });
    }
  }
  return [...servers.values()].sort((a, b) => a.name.localeCompare(b.name) || a.destination.localeCompare(b.destination));
}
