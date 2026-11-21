//! The pack GET and its time budget (chapter 00 §0.6, chapter 08 §8.9, #5331).
//!
//! A pack is up to 32 MiB (`PACK_HARD_MAX_BYTES`,
//! `apps/sync-server/src/services/pack-compaction.ts:88`), and the 60 s ceiling
//! every other request gets includes the response body, so an 8 MiB pack fails
//! every attempt below about 1.1 Mbit/s. The pack GET instead gets a deadline
//! scaled to the listed `byteSize` and to the [`RECORD_DOWNLOAD_WIDTH`] packs
//! that share the line, and the shell's idle timeout (`IDLE_TIMEOUT_MS`) still
//! ends a transfer that stalls. A GET that ran out its deadline is not retried
//! from byte 0 ([`RetryPolicy::pack`]).

use crate::protocol::http::{
    ApiRequest, Auth, DEFAULT_REQUEST_TIMEOUT_MS, HttpClient, RetryPolicy,
};

use super::PackSummary;
use super::records::RECORD_DOWNLOAD_WIDTH;

/// The slowest line the pack phase must still finish on: 0.25 Mbit/s, half
/// the 0.5 Mbit/s target, so a line at the target finishes with 2x margin.
const MIN_BYTES_PER_SECOND: u64 = 31_250;

/// The longest deadline any pack GET gets. It covers a 32 MiB pack sharing
/// [`MIN_BYTES_PER_SECOND`] with two others (3,281 s), and it is the deadline
/// when the listing carries no `byteSize`: an old server's pack still
/// downloads, and the idle timeout still ends a stall.
pub const PACK_DEADLINE_CAP_MS: u64 = 3_300_000;

/// Chapter 00 §0.6: the ordinary ceiling as a fixed allowance for the
/// request, the header, index and footer outside `byteSize`, plus the payload
/// at a third of [`MIN_BYTES_PER_SECOND`], because [`RECORD_DOWNLOAD_WIDTH`]
/// packs download at once; capped at [`PACK_DEADLINE_CAP_MS`].
pub fn pack_deadline_ms(byte_size: Option<u64>) -> u64 {
    byte_size.map_or(PACK_DEADLINE_CAP_MS, |bytes| {
        let transfer_ms =
            bytes.saturating_mul(1000 * RECORD_DOWNLOAD_WIDTH as u64) / MIN_BYTES_PER_SECOND;
        DEFAULT_REQUEST_TIMEOUT_MS
            .saturating_add(transfer_ms)
            .min(PACK_DEADLINE_CAP_MS)
    })
}

pub(super) async fn download(http: &HttpClient, pack: &PackSummary) -> Result<Vec<u8>, String> {
    let mut request = ApiRequest::new("GET", &pack.url)
        .auth(Auth::None)
        .retry(RetryPolicy::pack());
    request.timeout_ms = pack_deadline_ms(pack.byte_size);
    http.send(request)
        .await
        .map(|response| response.body)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: u64 = 1024 * 1024;

    #[test]
    fn an_unlisted_size_gets_the_cap_and_the_largest_pack_fits_under_it() {
        assert_eq!(pack_deadline_ms(None), PACK_DEADLINE_CAP_MS);
        assert_eq!(pack_deadline_ms(Some(0)), DEFAULT_REQUEST_TIMEOUT_MS);
        assert_eq!(pack_deadline_ms(Some(8 * MIB)), 865_306);
        assert_eq!(pack_deadline_ms(Some(24 * MIB)), 2_475_919);
        assert!(pack_deadline_ms(Some(32 * MIB)) < PACK_DEADLINE_CAP_MS);
        assert_eq!(pack_deadline_ms(Some(u64::MAX)), PACK_DEADLINE_CAP_MS);
    }
}
