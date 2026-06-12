import sodium from 'libsodium-wrappers-sumo'

export async function getSodium(): Promise<typeof sodium> {
  await sodium.ready
  return sodium
}
