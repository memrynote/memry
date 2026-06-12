/**
 * Irreversibly delete all data for a user across R2 (encrypted payloads) and
 * D1 (sync + auth rows). Child rows are deleted before the parent `users` row
 * to avoid foreign-key violations.
 */
export async function deleteUserData(
  db: D1Database,
  bucket: R2Bucket,
  userId: string,
  email: string
): Promise<void> {
  let cursor: string | undefined
  do {
    const listing = await bucket.list({ prefix: `${userId}/`, cursor })
    const keys = listing.objects.map((o) => o.key)
    if (keys.length > 0) {
      await bucket.delete(keys)
    }
    cursor = listing.truncated ? listing.cursor : undefined
  } while (cursor)

  await db.batch([
    // deepest children first (tables that reference devices or sync_items)
    db.prepare('DELETE FROM google_calendar_channels WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM crdt_updates WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM crdt_snapshots WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM upload_sessions WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM blob_chunks WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM device_sync_state WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM sync_items WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM server_cursor_sequence WHERE user_id = ?').bind(userId),
    // linking_sessions references devices as initiator_device_id
    db.prepare('DELETE FROM linking_sessions WHERE user_id = ?').bind(userId),
    // refresh_tokens references devices
    db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM sync_entitlements WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM sync_vaults WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM consumed_setup_tokens WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM devices WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM user_identities WHERE user_id = ?').bind(userId),
    // otp_codes is keyed by email, no FK
    db.prepare('DELETE FROM otp_codes WHERE email = ?').bind(email),
    // users row last (parent)
    db.prepare('DELETE FROM users WHERE id = ?').bind(userId)
  ])
}
