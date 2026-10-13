import os from 'node:os';

export function listIPv4Interfaces(networkInterfaces = os.networkInterfaces()) {
  const candidates = [];
  for (const [name, entries] of Object.entries(networkInterfaces)) {
    for (const entry of entries ?? []) {
      const family = typeof entry.family === 'string' ? entry.family : entry.family === 4 ? 'IPv4' : '';
      if (family !== 'IPv4' || entry.internal || entry.address.startsWith('169.254.')) continue;
      candidates.push({ name, address: entry.address, netmask: entry.netmask, mac: entry.mac });
    }
  }
  return candidates;
}

export function selectAddress(candidates, network) {
  if (network.manualAddress) {
    const match = candidates.find((item) => item.address === network.manualAddress);
    return match ? { selected: match, needsSelection: false, reason: 'manual' } :
      { selected: null, needsSelection: true, reason: 'manual-address-unavailable' };
  }
  if (network.preferredInterface) {
    const match = candidates.find((item) => item.name === network.preferredInterface);
    return match ? { selected: match, needsSelection: false, reason: 'preferred-interface' } :
      { selected: null, needsSelection: true, reason: 'preferred-interface-unavailable' };
  }
  if (candidates.length === 1) return { selected: candidates[0], needsSelection: false, reason: 'only-candidate' };
  return { selected: null, needsSelection: candidates.length !== 1, reason: candidates.length ? 'multiple-candidates' : 'no-lan-address' };
}
