// Registers ts-node's ESM loader via the modern `node:module` hook API, so
// our one-off scripts/*.ts helpers (validate:agents, fix-room-urls,
// bootstrap:admin) can run directly under Node without a separate compile
// step. Passed to `node --import` from package.json scripts.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('ts-node/esm', pathToFileURL('./'));
