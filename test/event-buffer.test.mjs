import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBuffer } from '../src/event-buffer.mjs';

test('bounds event history and redacts common credentials', () => {
  const events = new EventBuffer({ capacity: 2, maxRecordLength: 30 });
  events.log('api', 'stdout', 'Bearer topsecret password=hunter2');
  events.publish('state', {});
  events.publish('state', {});
  events.publish('state', {});
  const replay = events.replay(1);
  assert.equal(replay.records.length, 2);
  assert.equal(replay.truncated, true);
  const redacted = new EventBuffer();
  redacted.log('api', 'stdout', 'Bearer topsecret password=hunter2');
  assert.doesNotMatch(JSON.stringify(redacted.records), /topsecret|hunter2/);
});

test('removes ANSI color and terminal control sequences from service output', () => {
  const events = new EventBuffer();
  events.log('api', 'stdout', '\u001b[90m.\u001b[39m\u001b[0m ready');
  assert.equal(events.records[0].data.message, '. ready');
  assert.doesNotMatch(events.records[0].data.message, /\u001b|\[90m|\[39m/);
});
