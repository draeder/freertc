import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import {
  firstWorkersDevUrlFromText,
  relaySecretNames,
  relayUrlFromWorkersDevUrl,
  scopedWranglerArgs
} from "../scripts/deploy-cloudflare.mjs";
import worker, { resolveRelayPeerId } from "../src/index.js";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("README presents the official Deploy to Cloudflare button before manual install", async () => {
  const readme = await read("README.md");
  const button = "[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/draeder/freertc)";

  assert.match(readme, /## Deploy your own federated relay/);
  assert.ok(readme.includes(button));
  assert.ok(readme.indexOf(button) < readme.indexOf("## Install from npm (manual)"));
});

test("Deploy Button does not advertise optional local settings as required secrets", async () => {
  await assert.rejects(access(new URL(".env.example", root)));
});

test("Deploy Button configuration provisions D1, migrations, and private relay identity", async () => {
  const [buttonConfig, workersDevConfig, packageText, deployScript, workerSource, initialMigration, kademliaMigration, schema] = await Promise.all([
    read("wrangler.jsonc"),
    read("wrangler.workers-dev.jsonc"),
    read("package.json"),
    read("scripts/deploy-cloudflare.mjs"),
    read("src/index.js"),
    read("migrations/0001_initial.sql"),
    read("migrations/0002_kademlia_overlay.sql"),
    read("scripts/d1-schema.sql")
  ]);
  const packageJson = JSON.parse(packageText);

  for (const config of [buttonConfig, workersDevConfig]) {
    assert.match(config, /"workers_dev"\s*:\s*true/);
    assert.match(config, /"GLOBAL_RELAY_URL"\s*:\s*"wss:\/\/peer\.ooo\/ws"/);
    assert.doesNotMatch(config, /"RELAY_URL"\s*:/);
    assert.match(config, /"migrations_dir"\s*:\s*"migrations"/);
    assert.doesNotMatch(config, /peer-ooo-worker-devtest|52acefe2/i);
  }

  assert.doesNotMatch(buttonConfig, /"database_name"\s*:/);
  assert.doesNotMatch(buttonConfig, /"database_id"\s*:/);
  assert.doesNotMatch(buttonConfig, /"RELAY_PEER_ID"\s*:/);
  assert.match(workersDevConfig, /"database_id"\s*:\s*"00000000-0000-0000-0000-000000000000"/);
  assert.doesNotMatch(workerSource, /bootstrap-relay/);

  assert.equal(packageJson.scripts.deploy, "node scripts/deploy-cloudflare.mjs");
  assert.equal(packageJson.scripts.build, "wrangler deploy --dry-run --outdir dist");
  assert.equal(packageJson.scripts["d1:init:remote"], "wrangler d1 migrations apply DB --remote");
  assert.match(initialMigration, /CREATE TABLE IF NOT EXISTS psp_relays/);
  assert.match(kademliaMigration, /CREATE TABLE IF NOT EXISTS psp_kad_nodes/);
  const normalizeSql = (sql) => sql.replace(/^--.*$/gm, "").replace(/\s+/g, " ").trim();
  assert.equal(normalizeSql(`${initialMigration}\n${kademliaMigration}`), normalizeSql(schema));
  assert.match(deployScript, /'d1', 'migrations', 'apply', 'DB', '--remote'/);
  assert.match(deployScript, /generateRandomPair/);
  assert.match(deployScript, /'secret', 'bulk'/);
  assert.doesNotMatch(deployScript, /console\.log\([^\n]*(pair\.priv|secretInput)/);
});

test("one-click relays derive a unique bootstrap peer ID from their workers.dev hostname", () => {
  const relayUrl = "wss://freertc-relay.example-account.workers.dev/ws";

  assert.equal(
    resolveRelayPeerId(undefined, relayUrl),
    "bootstrap:freertc-relay.example-account.workers.dev"
  );
  assert.equal(resolveRelayPeerId("custom-relay", relayUrl), "custom-relay");
  assert.equal(resolveRelayPeerId(undefined, null), "bootstrap:local");
});

test("deployment helpers preserve Wrangler scope and detect an existing identity", () => {
  assert.deepEqual(
    scopedWranglerArgs(['--env', 'production', '--config=custom.jsonc', '--minify']),
    ['--env', 'production', '--config=custom.jsonc']
  );
  assert.deepEqual(
    scopedWranglerArgs(['--name', 'relay-a', '--env=production'], { includeName: true }),
    ['--name', 'relay-a', '--env=production']
  );
  assert.deepEqual(
    relaySecretNames('[{"name":"RELAY_IDENTITY_SECRET","type":"secret_text"}]'),
    ['RELAY_IDENTITY_SECRET']
  );
});

test("deployment output resolves to the relay URL used for registration", () => {
  const deploymentUrl = firstWorkersDevUrlFromText(
    "Deployed freertc at https://freertc-relay.example-account.workers.dev"
  );

  assert.equal(deploymentUrl, "https://freertc-relay.example-account.workers.dev");
  assert.equal(
    relayUrlFromWorkersDevUrl(deploymentUrl),
    "wss://freertc-relay.example-account.workers.dev/ws"
  );
  assert.equal(relayUrlFromWorkersDevUrl("https://relay.example.com"), null);
});

test("the first workers.dev request registers that domain with the federation hub", async () => {
  const databaseWrites = [];
  const database = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async run() {
              databaseWrites.push({ sql, values });
              return { success: true };
            },
            async all() {
              return { results: [] };
            }
          };
        }
      };
    }
  };
  const pending = [];
  const context = { waitUntil(promise) { pending.push(promise); } };
  const originalFetch = globalThis.fetch;
  let registration = null;

  globalThis.fetch = async (url, options) => {
    registration = { url: String(url), options };
    return new Response(JSON.stringify({ ok: true, relays: [] }), {
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const response = await worker.fetch(
      new Request("https://freertc-relay.example-account.workers.dev/health"),
      {
        DB: database,
        GLOBAL_RELAY_URL: "wss://peer.ooo/ws"
      },
      context
    );
    const health = await response.json();
    await Promise.all(pending);

    assert.equal(response.status, 200);
    assert.equal(health.relay_url, "wss://freertc-relay.example-account.workers.dev/ws");
    assert.equal(health.relay_peer_id, "bootstrap:freertc-relay.example-account.workers.dev");
    assert.equal(health.federation_hub, "wss://peer.ooo/ws");
    assert.equal(registration.url, "https://peer.ooo/api/v1/relays");
    assert.deepEqual(JSON.parse(registration.options.body), {
      url: "wss://freertc-relay.example-account.workers.dev/ws",
      name: "freertc-relay.example-account.workers.dev"
    });
    assert.equal(databaseWrites.length, 1);
    assert.deepEqual(databaseWrites[0].values.slice(0, 2), [
      "wss://freertc-relay.example-account.workers.dev/ws",
      "freertc-relay.example-account.workers.dev"
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
