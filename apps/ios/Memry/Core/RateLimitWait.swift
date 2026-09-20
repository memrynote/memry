import Foundation

/// How long a rate-limited caller has to wait, said in words a user can act on.
///
/// The server answers `Retry-After` in seconds and the window can be long — a
/// real staging reply was 2358. "Try again in a little while" against
/// thirty-nine minutes sends the user straight back to a button that refuses
/// them again, so the wait is named when it is known.
///
/// **Whole minutes, rounded up, and never a ticking count.** A duration the
/// user cannot shorten is not something to watch elapse; it is one sentence
/// telling them when to come back. Under a minute stays vague on purpose,
/// because "in 43 seconds" invites exactly the watching this avoids.
struct RateLimitWait {
    let seconds: UInt64?

    var guidance: String {
        guard let seconds, seconds > 0 else {
            // The server said nothing about how long. Saying a number here
            // would be inventing one.
            return "Nothing has been lost. Try again in a little while."
        }
        if seconds < 60 {
            return "Nothing has been lost. Try again in a moment."
        }
        let minutes = Int((seconds + 59) / 60)
        if minutes < 60 {
            return "Nothing has been lost. Try again in about \(minutes) minute\(minutes == 1 ? "" : "s")."
        }
        let hours = Int((seconds + 3599) / 3600)
        return "Nothing has been lost. Try again in about \(hours) hour\(hours == 1 ? "" : "s")."
    }
}
