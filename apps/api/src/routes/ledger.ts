import { ownerRouter, queryFields } from './common.js';
import {
  ObservationLedger,
  type LedgerFilters,
} from '../../../../packages/core/src/knowledge/ledger.js';
export const ledgerApp = ownerRouter();
ledgerApp.get('/', async (c) => {
  queryFields(c, [
    'entity_id',
    'source_id',
    'kind',
    'date',
    'profile_id',
    'limit',
    'cursor',
  ]);
  const filters: LedgerFilters = {};
  for (const key of [
    'entity_id',
    'source_id',
    'kind',
    'date',
    'profile_id',
  ] as const) {
    const value = c.req.query(key);
    if (value !== undefined) filters[key] = value;
  }
  return c.json(
    await new ObservationLedger(c.env.DB, c.get('access')).page(
      filters,
      Number(c.req.query('limit') ?? 20),
      c.env.SESSION_SIGNING_SECRET!,
      new Date(),
      c.req.query('cursor'),
    ),
  );
});
