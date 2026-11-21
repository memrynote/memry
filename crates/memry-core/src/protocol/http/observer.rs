//! What a run can watch of its own requests, without owning them.

/// Told about each attempt the retry ladder makes, for the run that derived
/// the client with [`super::HttpClient::observed`].
///
/// Both calls are synchronous and run inside the request, so an observer
/// records and returns.
pub trait RequestObserver: Send + Sync {
    /// One attempt was put on the wire. `status` is the HTTP status, or `None`
    /// when no answer came back. `elapsed_ms` is the wire time of this
    /// attempt alone: it excludes token refresh and the ladder's sleeps.
    fn attempt(&self, status: Option<u16>, elapsed_ms: u64);

    /// The ladder, or a caller pausing for the same reason, is about to wait
    /// `wait_ms` before trying again. `status` is what the failed attempt
    /// answered, or `None` for a transport failure.
    fn retry(&self, status: Option<u16>, wait_ms: u64);
}
