import test from 'node:test';
import assert from 'node:assert/strict';
import { listIPv4Interfaces, selectAddress } from '../src/network.mjs';

test('filters loopback and link-local, selects only unambiguous LAN address', () => {
  const candidates = listIPv4Interfaces({
    lo: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', mac: '00', internal: true }],
    wifi: [{ family: 'IPv4', address: '192.0.2.30', netmask: '255.255.255.0', mac: '01', internal: false }],
    apipa: [{ family: 'IPv4', address: '169.254.1.3', netmask: '255.255.0.0', mac: '02', internal: false }],
  });
  assert.deepEqual(candidates.map((item) => item.address), ['192.0.2.30']);
  assert.equal(selectAddress(candidates, {}).selected.address, '192.0.2.30');
});

test('requires selection among multiple interfaces and validates saved choice', () => {
  const candidates = [{ name: 'Wi-Fi', address: '192.0.2.20' }, { name: 'VPN', address: '198.51.100.3' }];
  assert.equal(selectAddress(candidates, {}).reason, 'multiple-candidates');
  assert.equal(selectAddress(candidates, { manualAddress: '198.51.100.3' }).selected.name, 'VPN');
  assert.equal(selectAddress(candidates, { preferredInterface: 'gone' }).selected, null);
});
