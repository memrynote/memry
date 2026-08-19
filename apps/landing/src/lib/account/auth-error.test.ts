import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { authErrorMessage } from './auth-error.ts'

describe('authErrorMessage', () => {
  it('passes a server error through unchanged', () => {
    assert.equal(
      authErrorMessage(new Error('Invalid or expired code'), 'Invalid code'),
      'Invalid or expired code'
    )
  })

  it('falls back when the thrown value is not an error', () => {
    assert.equal(authErrorMessage('boom', 'Sign-in failed'), 'Sign-in failed')
    assert.equal(authErrorMessage(new Error(''), 'Sign-in failed'), 'Sign-in failed')
  })

  it('replaces libsodium abort text with something a person can act on', () => {
    const abort = new Error(
      'Aborted(CompileError: call to WebAssembly.instantiate() blocked by CSP). Build with -sASSERTIONS for more info.'
    )
    const message = authErrorMessage(abort, 'Invalid code')
    assert.ok(!message.includes('Aborted('), 'raw abort text leaked to the user')
    assert.match(message, /Secure sign-in could not start/)
  })

  it('replaces the other engines’ wording for the same abort', () => {
    const firefox = new Error('Aborted(CompileError: WebAssembly.instantiate(): ...)')
    const chrome = new Error('Refused to create a WebAssembly object because CSP')
    assert.match(authErrorMessage(firefox, 'Invalid code'), /Secure sign-in could not start/)
    assert.match(authErrorMessage(chrome, 'Invalid code'), /Secure sign-in could not start/)
  })
})
