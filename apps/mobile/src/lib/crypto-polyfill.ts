/**
 * Hermes ships no global `crypto`; nanoid (via @memry/app-core/ids) needs
 * crypto.getRandomValues (R3 spike finding). Back it with the libsodium JSI
 * binding already linked into the app — no extra native module, and the
 * randomness source is the same CSPRNG the vault crypto uses.
 *
 * Must be imported before anything that touches `crypto` (first import of the
 * root layout).
 */
import sodium from 'react-native-libsodium'

type IntArray =
  Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array

const getRandomValues = <T extends IntArray>(array: T): T => {
  const bytes = sodium.randombytes_buf(array.byteLength)
  new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(bytes)
  return array
}

const globalScope = globalThis as { crypto?: { getRandomValues?: typeof getRandomValues } }

if (!globalScope.crypto) {
  globalScope.crypto = { getRandomValues }
} else if (!globalScope.crypto.getRandomValues) {
  globalScope.crypto.getRandomValues = getRandomValues
}
