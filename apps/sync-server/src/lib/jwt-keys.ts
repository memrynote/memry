import { importSPKI, importPKCS8 } from 'jose'

const ALGORITHM = 'EdDSA'

const normalizePem = (pem: string): string => pem.replace(/\\n/g, '\n')

export const getPublicKey = async (pem: string): Promise<CryptoKey> =>
  importSPKI(normalizePem(pem), ALGORITHM)

export const getPrivateKey = async (pem: string): Promise<CryptoKey> =>
  importPKCS8(normalizePem(pem), ALGORITHM)
