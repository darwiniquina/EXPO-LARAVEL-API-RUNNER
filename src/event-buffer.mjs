const REDACTIONS = [
  /(\bbearer\s+)[^\s,;]+/gi,
  /(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi,
  /((?:password|passwd|token|api[_-]?key|secret)\s*[:=]\s*)[^\s,;]+/gi,
];

const ANSI_ESCAPE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])/g;

export class EventBuffer {
  constructor({ capacity = 1200, maxRecordLength = 4000 } = {}) {
    this.capacity = capacity;
    this.maxRecordLength = maxRecordLength;
    this.sequence = 0;
    this.records = [];
    this.clients = new Set();
  }

  publish(type, data) {
    const record = { id: ++this.sequence, type, data, at: new Date().toISOString() };
    this.records.push(record);
    if (this.records.length > this.capacity) this.records.splice(0, this.records.length - this.capacity);
    const encoded = `id: ${record.id}\nevent: ${type}\ndata: ${JSON.stringify(record)}\n\n`;
    for (const response of this.clients) {
      if (response.needsDrain) {
        response.droppedEvents = (response.droppedEvents ?? 0) + 1;
        continue;
      }
      if (!response.write(encoded)) response.needsDrain = true;
    }
    return record;
  }

  log(service, stream, chunk) {
    const lines = String(chunk).replace(ANSI_ESCAPE, '').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let message = line.slice(0, this.maxRecordLength);
      for (const pattern of REDACTIONS) message = message.replace(pattern, '$1[redacted]');
      this.publish('log', { service, stream, message, truncated: line.length > this.maxRecordLength });
    }
  }

  replay(afterId = 0) {
    const first = this.records[0]?.id ?? this.sequence + 1;
    return {
      truncated: afterId > 0 && afterId < first - 1,
      records: this.records.filter((record) => record.id > afterId),
    };
  }
}
