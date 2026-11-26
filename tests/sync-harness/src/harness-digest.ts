import { createHash } from 'node:crypto'
import type { SimulatedDevice } from './simulated-device.js'
import type { DeviceDigests } from './zero-loss-oracle/index.js'

/** Harness stand-in for the §12.11 digest: the record content plus the body's applied payloads. */
export const harnessDigest = (content: Record<string, unknown>, bodyParts: string[]): string =>
  createHash('sha256')
    .update(`${JSON.stringify(content)}\n${bodyParts.join(',')}`)
    .digest('hex')

/** Every live item's harness digest on a device, for `checkSemantic`. */
export const harnessDigests = (label: string, device: SimulatedDevice): DeviceDigests => {
  const digests: Record<string, string> = {}
  for (const item of device.getAllItems().values()) {
    if (item.operation === 'delete') continue
    digests[item.id] = harnessDigest(item.content, device.getBodyParts(item.id))
  }
  return { label, digests }
}
