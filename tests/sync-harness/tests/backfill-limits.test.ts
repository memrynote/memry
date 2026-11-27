import { describe, expect, it } from 'vitest'
import { PACK_LIST_MAX_PACKS_PER_VAULT } from '@memry/contracts/sync-api'
import {
  PACK_MIN_FILL_ROWS,
  PACK_SETTLE_SECONDS
} from '../../../apps/sync-server/src/services/pack-sizing.js'
import { REWRITE_PENDING } from '../../../apps/sync-server/src/services/pack-replaced-objects.js'
import { BACKFILL_LIMITS } from '../src/simulated-server.js'

describe('the harness backfill settle', () => {
  it('reads the backlog with the Worker limits', () => {
    expect(BACKFILL_LIMITS).toEqual({
      minFillRows: PACK_MIN_FILL_ROWS,
      settleSeconds: PACK_SETTLE_SECONDS,
      maxPacksPerVault: PACK_LIST_MAX_PACKS_PER_VAULT,
      rewritePending: REWRITE_PENDING
    })
  })
})
