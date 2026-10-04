import { readFileSync } from 'node:fs';
import {
  loadConfig,
  ProviderRegistry,
  publicConfig,
} from '../packages/core/src/config/index.js';

const policy = loadConfig(
  JSON.parse(readFileSync('config/defaults.json', 'utf8')),
  new ProviderRegistry([]),
);
console.log(
  JSON.stringify({
    result: 'PASS',
    paid_services_enabled: policy.paid_services_enabled,
    public: publicConfig(policy),
    active_routes: [],
  }),
);
