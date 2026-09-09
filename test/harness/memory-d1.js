// In-memory stand-in for the D1 tables the overlay and registry read.
// Statements are matched by the table they name, the same way the worker
// tests have always driven the overlay without a real database.
export class MemoryD1 {
  constructor() {
    this.nodes = new Map();
    this.records = new Map();
  }

  prepare(sql) {
    const db = this;
    return {
      bind(...values) {
        return {
          async run() {
            if (sql.includes('INSERT INTO psp_kad_nodes')) {
              const [nodeId, bucketIndex, url, recordJson, expiresAt, lastSeen] = values;
              db.nodes.set(nodeId, {
                node_id: nodeId,
                bucket_index: bucketIndex,
                url,
                record_json: recordJson,
                expires_at_ms: expiresAt,
                last_seen_ms: lastSeen,
              });
            } else if (sql.includes('INSERT INTO psp_kad_records')) {
              const [routingKey, ownerNodeId, kind, sequence, recordJson, expiresAt] = values;
              const key = `${routingKey}:${ownerNodeId}:${kind}`;
              const previous = db.records.get(key);
              if (!previous || sequence > previous.sequence) {
                db.records.set(key, {
                  routing_key: routingKey,
                  owner_node_id: ownerNodeId,
                  kind,
                  sequence,
                  record_json: recordJson,
                  expires_at_ms: expiresAt,
                });
              }
            }
            return { success: true };
          },
          async all() {
            if (sql.includes('FROM psp_kad_nodes')) {
              const [now, limit] = values;
              return {
                results: [...db.nodes.values()]
                  .filter((row) => row.expires_at_ms > now)
                  .sort((left, right) => right.last_seen_ms - left.last_seen_ms)
                  .slice(0, limit),
              };
            }
            if (sql.includes('FROM psp_kad_records')) {
              const [routingKey, now, limit] = values;
              return {
                results: [...db.records.values()]
                  .filter((row) => row.routing_key === routingKey && row.expires_at_ms > now)
                  .sort((left, right) => right.sequence - left.sequence)
                  .slice(0, limit),
              };
            }
            return { results: [] };
          },
        };
      },
    };
  }
}
