import { describe, expectTypeOf, it } from 'vitest'

describe('preload type declarations', () => {
  it('exposes sync and crypto APIs on window.api', () => {
    expectTypeOf<Window['api']['syncAuth']['requestOtp']>().toBeFunction()
    expectTypeOf<Window['api']['syncSetup']['setupFirstDevice']>().toBeFunction()
    expectTypeOf<Window['api']['syncLinking']['generateLinkingQr']>().toBeFunction()
    expectTypeOf<Window['api']['syncDevices']['getDevices']>().toBeFunction()
    expectTypeOf<Window['api']['syncOps']['triggerSync']>().toBeFunction()
    expectTypeOf<Window['api']['crypto']['encryptItem']>().toBeFunction()
    expectTypeOf<Window['api']['syncAttachments']['upload']>().toBeFunction()
    expectTypeOf<Window['api']['onSyncStatusChanged']>().toBeFunction()
  })
})
