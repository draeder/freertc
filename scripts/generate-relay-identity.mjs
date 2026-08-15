#!/usr/bin/env node

import { generateRandomPair } from 'unsea';
import { encodeRelayIdentitySecret } from '../src/relay-identity.js';

const identity = await generateRandomPair();

console.log('Generated a stable UnSEA relay signing identity.');
console.log('Keep the private key secret and reuse this pair across deployments of the same relay.');
console.log('');
console.log(`RELAY_IDENTITY_SECRET='${encodeRelayIdentitySecret(identity.pub, identity.priv)}'`);
console.log('');
console.log('For manual recovery only, store that complete value as RELAY_IDENTITY_SECRET.');
console.log('Normal deploy and dev:cf commands generate and install it automatically.');
