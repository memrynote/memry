import { importSPKI, importPKCS8 } from 'jose'

const ALGORITHM = 'EdDSA'

let cachedPublicPem: string | null = null
let cachedPublicKey: CryptoKey | null = null

let cachedPrivatePem: string | null = null
let cachedPrivateKey: CryptoKey | null = null

export const getPublicKey = async (pem: string): Promise<CryptoKey> => {
  if (cachedPublicKey && cachedPublicPem === pem) return cachedPublicKey
  const key = await importSPKI(pem, ALGORITHM)
  cachedPublicPem = pem
  cachedPublicKey = key
  return key
}

export const getPrivateKey = async (pem: string): Promise<CryptoKey> => {
  if (cachedPrivateKey && cachedPrivatePem === pem) return cachedPrivateKey
  const key = await importPKCS8(pem, ALGORITHM)
  cachedPrivatePem = pem
  cachedPrivateKey = key
  return key
}
