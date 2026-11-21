//! The pack GET, its time budget, and the downloads of one phase (chapter 00
//! §0.6, chapter 08 §8.9, §8.12, #5331, #5374).
//!
//! A pack is up to 32 MiB (`PACK_HARD_MAX_BYTES`,
//! `apps/sync-server/src/services/pack-compaction.ts:88`), and the 60 s ceiling
//! every other request gets includes the response body, so an 8 MiB pack fails
//! every attempt below about 1.1 Mbit/s. The pack GET instead gets a deadline
//! scaled to the listed `byteSize` and to the [`RECORD_DOWNLOAD_WIDTH`] packs
//! that share the line, and the shell's idle timeout (`IDLE_TIMEOUT_MS`) still
//! ends a transfer that stalls. A GET that ran out its deadline is not retried
//! from byte 0 ([`RetryPolicy::pack`]).
//!
//! The transport ladder spends its three retries in 14 s, and an offline
//! error comes back at once, so a 30 s drop used to end every pack in flight
//! and leave the whole vault to the item routes (#5374: 12,455 per-document
//! GETs). [`Downloads`] pauses the phase instead: a pack lost to the network
//! waits out [`PACK_RETRY_PAUSES`] doubling pauses, then downloads again,
//! re-signed first when its URL expired during the wait.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::task::{JoinError, JoinSet};
use tokio::time::Instant;

use crate::api::errors::{ApiError, TransportError};
use crate::protocol::http::{
    ApiRequest, Auth, DEFAULT_REQUEST_TIMEOUT_MS, HttpClient, RetryPolicy,
};

use super::PackSummary;
use super::listing::list;
use super::records::RECORD_DOWNLOAD_WIDTH;

/// The slowest line the pack phase must still finish on: 0.25 Mbit/s, half
/// the 0.5 Mbit/s target, so a line at the target finishes with 2x margin.
const MIN_BYTES_PER_SECOND: u64 = 31_250;

/// The longest deadline any pack GET gets. It covers a 32 MiB pack sharing
/// [`MIN_BYTES_PER_SECOND`] with two others (3,281 s), and it is the deadline
/// when the listing carries no `byteSize`: an old server's pack still
/// downloads, and the idle timeout still ends a stall.
pub const PACK_DEADLINE_CAP_MS: u64 = 3_300_000;

/// Pauses one phase takes for a lost network. The pauses wait 30, 60, 120
/// and 240 s, so a drop of up to about eight minutes costs no pack; a longer
/// one leaves the packs still failing as gaps (§8.10).
pub const PACK_RETRY_PAUSES: u32 = 4;

/// The first pause; each later one doubles it.
pub const PACK_RETRY_FIRST_PAUSE_MS: u64 = 30_000;

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

async fn download(http: &HttpClient, pack: &PackSummary) -> Result<Vec<u8>, ApiError> {
    let mut request = ApiRequest::new("GET", &pack.url)
        .auth(Auth::None)
        .retry(RetryPolicy::pack());
    request.timeout_ms = pack_deadline_ms(pack.byte_size);
    http.send(request).await.map(|response| response.body)
}

type Finished<T> = (PackSummary, T, Result<Vec<u8>, ApiError>);

/// The longest `Retry-After` a pause honours: the last pause.
const MAX_PAUSE_MS: u64 = PACK_RETRY_FIRST_PAUSE_MS << (PACK_RETRY_PAUSES - 1);

/// One phase's pack downloads, [`RECORD_DOWNLOAD_WIDTH`] at a time. `T`
/// rides along with each pack.
pub(super) struct Downloads<T> {
    http: Arc<HttpClient>,
    vault_id: Option<String>,
    /// The caller's `now_s` when the phase began; see [`phase_now`].
    now_s: i64,
    began: Instant,
    queue: VecDeque<(PackSummary, T)>,
    running: JoinSet<Finished<T>>,
    /// Packs the network lost, waiting for the pause to end.
    lost: Vec<(PackSummary, T)>,
    /// The longest `Retry-After` among them.
    retry_after_ms: u64,
    /// Whether a pack waiting in `lost` was refused with a 429.
    rate_limited: bool,
    pauses: u32,
    /// The last re-list and the pause count it was made at.
    relisted: Option<(u32, Vec<PackSummary>)>,
}

impl<T: Send + 'static> Downloads<T> {
    pub(super) fn new(
        http: &Arc<HttpClient>,
        vault_id: Option<&str>,
        now_s: i64,
        packs: impl IntoIterator<Item = (PackSummary, T)>,
    ) -> Self {
        Self {
            http: Arc::clone(http),
            vault_id: vault_id.map(str::to_owned),
            now_s,
            began: Instant::now(),
            queue: packs.into_iter().collect(),
            running: JoinSet::new(),
            lost: Vec::new(),
            retry_after_ms: 0,
            rate_limited: false,
            pauses: 0,
            relisted: None,
        }
    }

    /// The next downloaded pack, `None` once every pack is downloaded or
    /// given up. A pack given up is absent (§8.12) and its reason is in
    /// `reasons`. `requests` counts the GETs and re-lists sent.
    pub(super) async fn next(
        &mut self,
        requests: &mut usize,
        reasons: &mut Vec<String>,
    ) -> Result<Option<(PackSummary, T, Vec<u8>)>, JoinError> {
        loop {
            // A lost network stops new downloads; the running ones finish.
            if self.lost.is_empty() {
                self.start(requests, reasons).await;
            }
            let Some(joined) = self.running.join_next().await else {
                if self.lost.is_empty() {
                    return Ok(None);
                }
                let pause = (PACK_RETRY_FIRST_PAUSE_MS << self.pauses).max(self.retry_after_ms);
                self.pauses += 1;
                self.retry_after_ms = 0;
                if std::mem::take(&mut self.rate_limited) {
                    self.http.paused(pause);
                }
                self.http.sleep_ms(pause).await;
                for lost in self.lost.drain(..).rev() {
                    self.queue.push_front(lost);
                }
                continue;
            };
            let (pack, carried, result) = joined?;
            match result {
                Ok(bytes) => return Ok(Some((pack, carried, bytes))),
                Err(error)
                    if self.pauses < PACK_RETRY_PAUSES && self.lost_to_network(&pack, &error) =>
                {
                    self.lose(pack, carried, &error);
                }
                Err(error) => reasons.push(format!("pack {}: {error}", pack.id)),
            }
        }
    }

    fn lose(&mut self, pack: PackSummary, carried: T, error: &ApiError) {
        if let ApiError::RateLimited { retry_after_s, .. } = error {
            self.rate_limited = true;
            if let Some(after_s) = retry_after_s {
                let after_ms = after_s.saturating_mul(1_000).min(MAX_PAUSE_MS);
                self.retry_after_ms = self.retry_after_ms.max(after_ms);
            }
        }
        self.lost.push((pack, carried));
    }

    async fn start(&mut self, requests: &mut usize, reasons: &mut Vec<String>) {
        while self.running.len() < RECORD_DOWNLOAD_WIDTH {
            let Some((mut pack, carried)) = self.queue.pop_front() else {
                break;
            };
            if !pack.live(phase_now(self.now_s, self.began)) {
                match self.resign(&pack.id, requests).await {
                    Ok(Some(fresh)) => {
                        pack.url = fresh.url;
                        pack.expires_at = fresh.expires_at;
                    }
                    Ok(None) => {
                        reasons.push(format!("pack {} expired and was not re-signed", pack.id));
                        continue;
                    }
                    // The re-list met the same drop: the pack waits for the
                    // pause with the others, and nothing new starts.
                    Err(error) if self.pauses < PACK_RETRY_PAUSES => {
                        self.lose(pack, carried, &error);
                        break;
                    }
                    Err(error) => {
                        self.relisted = Some((self.pauses, Vec::new()));
                        reasons.push(format!("pack {} was not re-signed: {error}", pack.id));
                        continue;
                    }
                }
            }
            *requests += 1;
            let http = Arc::clone(&self.http);
            self.running.spawn(async move {
                let bytes = download(&http, &pack).await;
                (pack, carried, bytes)
            });
        }
    }

    /// URLs are signed once at listing time and live 300 s. A run that
    /// outlived them re-lists for fresh ones, at most once per pause (§8.12).
    /// A pack a rollup replaced meanwhile is not found, and stays a gap. A
    /// re-list the network may cure is not remembered, so the next pause
    /// lists again; the error comes back for the pack to wait.
    async fn resign(
        &mut self,
        id: &str,
        requests: &mut usize,
    ) -> Result<Option<PackSummary>, ApiError> {
        let now = phase_now(self.now_s, self.began);
        let fresh = |packs: &[PackSummary]| {
            packs
                .iter()
                .find(|pack| pack.id == id && pack.live(now))
                .cloned()
        };
        if let Some((at, packs)) = &self.relisted {
            if let Some(pack) = fresh(packs) {
                return Ok(Some(pack));
            }
            if *at == self.pauses {
                return Ok(None);
            }
        }
        *requests += 1;
        let packs = match list(&self.http, self.vault_id.as_deref(), now).await {
            Ok(listing) => listing.packs,
            Err(error) if curable(&error, u64::MAX) => return Err(error),
            Err(_) => Vec::new(),
        };
        let pack = fresh(&packs);
        self.relisted = Some((self.pauses, packs));
        Ok(pack)
    }

    /// [`curable`] within the pack's deadline, or a 403 on a URL that
    /// expired while the ladder waited.
    fn lost_to_network(&self, pack: &PackSummary, error: &ApiError) -> bool {
        curable(error, pack_deadline_ms(pack.byte_size))
            || matches!(error, ApiError::Status { status: 403, .. })
                && !pack.live(phase_now(self.now_s, self.began))
    }
}

/// A failure the network may cure: no path, a dropped connection, a timeout
/// short of `deadline_ms` (an idle stall), a 5xx gateway or server error, or
/// a rate limit. A spent deadline, a 404 and a 401 are final.
fn curable(error: &ApiError, deadline_ms: u64) -> bool {
    match error {
        ApiError::Transport { source } => match source {
            TransportError::Offline | TransportError::Failed { .. } => true,
            TransportError::Timeout { elapsed_ms } => *elapsed_ms < deadline_ms,
            _ => false,
        },
        ApiError::Status { status, .. } => matches!(status, 500 | 502 | 503 | 504),
        ApiError::RateLimited { .. } => true,
        _ => false,
    }
}

/// The phase's clock for URL expiry, in unix seconds: the caller's `now_s`
/// plus the monotonic time since, which a paused test clock drives, or the
/// wall clock when that is later. A monotonic clock stops while an Apple
/// device sleeps, and a URL that expired meanwhile must not look live.
fn phase_now(now_s: i64, began: Instant) -> i64 {
    let wall = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs() as i64);
    wall.max(now_s + began.elapsed().as_secs() as i64)
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

    /// REVIEW-5383: a phase begun at `now_s` that the monotonic clock says
    /// is young still reads the wall clock once that is later.
    #[test]
    fn the_phase_clock_never_runs_behind_the_wall_clock() {
        let wall = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        assert!(phase_now(wall - 3_600, Instant::now()) >= wall);
        assert!(phase_now(wall + 3_600, Instant::now()) >= wall + 3_600);
    }
}
