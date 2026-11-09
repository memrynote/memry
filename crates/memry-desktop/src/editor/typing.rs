//! The typing barrier: an outside edit of a note that windows have open is fed only once each
//! window sent the typing it had not sent yet, so the consumer's choice between the typing and
//! the file sees every keystroke made before it.
//!
//! The consumer asks before it takes the rows' lane ([`EditorHost::hold_typing`]): each window
//! with the document open gets a [`BARRIER`] frame, sends its queued edits, holds new typing and
//! answers ([`EditorHost::typing_sent`]). The consumer waits [`BARRIER_WAIT`] at most; a window
//! that has not answered by then counts as holding no typing. A window lets typing go as the
//! outside edit's frame applies, since typing from then on lands in the blocks the edit made,
//! and the editor's own answer to the edit (a link it makes a chip of) must apply. The
//! [`TypingHold`] the consumer gets back sends each asked window a [`RELEASE`] frame once
//! dropped, for the choice that fed nothing (the typing won); it follows any edit's frame on the
//! same channel. A window releases itself if neither comes.
//!
//! Without the hold, a keystroke made after the window answered and before the edit's frame
//! reached it lands in blocks the edit deleted, and is lost when the window applies the frame.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use super::{Deliver, EditorHost};
use crate::session::lock;

/// The frame asking a window to send its typing and hold new typing: the byte, then the
/// barrier's id (u32, little endian).
pub const BARRIER: u8 = 5;
/// The frame letting the window type again when no outside edit's frame did: the byte, then the
/// id of the barrier it ends.
pub const RELEASE: u8 = 6;
/// How long an outside edit waits for the windows' typing.
pub const BARRIER_WAIT: Duration = Duration::from_millis(1500);

/// The barriers waiting for windows to answer.
#[derive(Default)]
pub(super) struct Barriers {
    next: AtomicU32,
    /// By barrier id, the windows that have not answered yet.
    waiting: Mutex<HashMap<u32, Vec<String>>>,
    answered: Condvar,
}

/// The windows an outside edit asked to hold their typing; dropping it releases them.
#[must_use = "the windows hold their typing until this is dropped"]
pub struct TypingHold {
    id: u32,
    windows: Vec<Deliver>,
}

impl Drop for TypingHold {
    fn drop(&mut self) {
        for window in &self.windows {
            window(id_frame(RELEASE, self.id));
        }
    }
}

fn id_frame(byte: u8, id: u32) -> Vec<u8> {
    let mut frame = vec![byte];
    frame.extend_from_slice(&id.to_le_bytes());
    frame
}

impl EditorHost {
    /// Asks every window that has `note_id` open to send its typing and hold new typing, and
    /// waits until each answered or `wait` passed. `None` when no window has it open.
    pub fn hold_typing(&self, note_id: &str, wait: Duration) -> Option<TypingHold> {
        let windows = self.subscribers(note_id);
        if windows.is_empty() {
            return None;
        }
        let barriers = &self.barriers;
        let id = barriers.next.fetch_add(1, Ordering::Relaxed);
        // Registered before any frame goes, so an answer never arrives before its barrier.
        lock(&barriers.waiting)
            .insert(id, windows.iter().map(|s| s.window_label.clone()).collect());
        let mut asked = Vec::with_capacity(windows.len());
        for window in windows {
            if (window.channel)(id_frame(BARRIER, id)) {
                asked.push(window.channel);
            } else {
                self.typing_sent(&window.window_label, id);
            }
        }
        let deadline = Instant::now() + wait;
        let mut waiting = lock(&barriers.waiting);
        while waiting.get(&id).is_some_and(|left| !left.is_empty()) {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                tracing::warn!(
                    scope = "editor",
                    note_id,
                    "a window did not send its typing before an outside edit"
                );
                break;
            }
            waiting = barriers
                .answered
                .wait_timeout(waiting, left)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        waiting.remove(&id);
        Some(TypingHold { id, windows: asked })
    }

    /// `window_label` sent its typing for barrier `id`, and holds new typing.
    pub fn typing_sent(&self, window_label: &str, id: u32) {
        let mut waiting = lock(&self.barriers.waiting);
        if let Some(left) = waiting.get_mut(&id) {
            left.retain(|label| label != window_label);
            self.barriers.answered.notify_all();
        }
    }
}
