import { describe, expect, it } from 'vitest'
import { parsePullItems } from './pull-envelope'

const item = (id: string) => ({
  id,
  type: 'task',
  operation: 'update',
  signature: 'sig',
  signerDeviceId: 'device-2',
  blob: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' }
})

describe('parsePullItems', () => {
  // #2292
  it('parses inline items per item, ahead of the pulled ones', () => {
    const parsed = parsePullItems({ items: [item('pulled')] }, [
      item('inline'),
      { id: 'inline-bad', type: 'task' },
      'no id'
    ])

    expect(parsed).toEqual({
      kind: 'envelope',
      items: [expect.objectContaining({ id: 'inline' }), expect.objectContaining({ id: 'pulled' })],
      invalid: [{ id: 'inline-bad', type: 'task' }],
      unnamed: 1
    })
  })

  // #2292 with #2285: a body that is not an envelope refuses the slice, inline or not.
  it('stays not_envelope when inline items come with a broken pull body', () => {
    expect(parsePullItems({ error: 'x' }, [item('inline')])).toEqual({ kind: 'not_envelope' })
  })
})
