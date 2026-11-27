//! Turn locks and the backends a turn runs: the turn half of Electron's `AgentRuntime`
//! (`runtime.ts:250-345`). One turn per conversation at a time; its write grant lives as long as
//! its [`Turn`]. A stop kills the conversation's backends and ends the turn's write capability, so
//! a backend that lives on for a moment raises no new card. Shutdown kills every backend and
//! closes the gate.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use super::grants::TurnGrant;
use super::write_gate::AgentWriteGate;

/// Stops a running backend: a signal to a CLI child, the abort of the in-process engine.
pub type KillBackend = Arc<dyn Fn() + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TurnError {
    /// `acquireTurnLock`'s refusal (`runtime.ts:268-272`).
    #[error(
        "There is already a turn in flight for conversation {0}; another window may be mid-turn."
    )]
    Busy(String),
    /// The vault closed; its agent starts no turn.
    #[error("The agent of this vault has stopped.")]
    Closed,
}

#[derive(Default)]
struct State {
    locked: HashSet<String>,
    /// A stop pressed while the turn's backend did not exist yet (`cancelRequested`).
    cancel_requested: HashSet<String>,
    backends: HashMap<u64, (String, KillBackend)>,
    next_backend: u64,
    closed: bool,
}

pub struct Turns {
    gate: Arc<AgentWriteGate>,
    state: Mutex<State>,
}

impl Turns {
    pub fn new(gate: Arc<AgentWriteGate>) -> Arc<Self> {
        Arc::new(Self {
            gate,
            state: Mutex::default(),
        })
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Takes the conversation's turn lock and mints the turn's write grant.
    pub fn begin(self: &Arc<Self>, conversation_id: &str) -> Result<Turn, TurnError> {
        {
            let mut state = self.state();
            if state.closed {
                return Err(TurnError::Closed);
            }
            if !state.locked.insert(conversation_id.to_owned()) {
                return Err(TurnError::Busy(conversation_id.to_owned()));
            }
            // A stop pressed against an earlier turn never reaches this one.
            state.cancel_requested.remove(conversation_id);
        }
        Ok(Turn {
            conversation_id: conversation_id.to_owned(),
            grant: self.gate.mint_turn_write_grant(conversation_id),
            turns: Arc::clone(self),
        })
    }

    /// Tracks a backend of the conversation until the returned handle drops. A backend that
    /// registers after its stop or after shutdown is killed at once (`trackSubprocess`).
    pub fn track_backend(
        self: &Arc<Self>,
        conversation_id: &str,
        kill: KillBackend,
    ) -> TrackedBackend {
        let (id, kill_now) = {
            let mut state = self.state();
            let id = state.next_backend;
            state.next_backend += 1;
            state
                .backends
                .insert(id, (conversation_id.to_owned(), Arc::clone(&kill)));
            let kill_now = state.closed || state.cancel_requested.contains(conversation_id);
            (id, kill_now)
        };
        if kill_now {
            kill();
        }
        TrackedBackend {
            id,
            turns: Arc::downgrade(self),
        }
    }

    /// Stop: kills the conversation's backends, then ends its write capability and denies the
    /// cards it left open.
    pub fn cancel(&self, conversation_id: &str) {
        let kills: Vec<KillBackend> = {
            let mut state = self.state();
            state.cancel_requested.insert(conversation_id.to_owned());
            state
                .backends
                .values()
                .filter(|(owner, _)| owner == conversation_id)
                .map(|(_, kill)| Arc::clone(kill))
                .collect()
        };
        for kill in kills {
            kill();
        }
        self.gate.cancel_turn(conversation_id);
    }

    /// Vault close, switch or quit: the gate refuses everything and every backend is killed.
    pub fn shutdown(&self) {
        let kills: Vec<KillBackend> = {
            let mut state = self.state();
            state.closed = true;
            state.locked.clear();
            state.cancel_requested.clear();
            state
                .backends
                .values()
                .map(|(_, kill)| Arc::clone(kill))
                .collect()
        };
        self.gate.shutdown();
        for kill in kills {
            kill();
        }
    }

    /// `releaseTurnLock`. The gate ends the turn before the lock goes, so a turn that starts
    /// right after keeps its own grant.
    fn release(&self, conversation_id: &str) {
        self.gate.end_turn(conversation_id);
        let mut state = self.state();
        state.locked.remove(conversation_id);
        state.cancel_requested.remove(conversation_id);
    }
}

/// A running turn. Dropping it releases the turn lock: the grant is revoked and the turn's open
/// cards are denied.
pub struct Turn {
    conversation_id: String,
    grant: TurnGrant,
    turns: Arc<Turns>,
}

impl Turn {
    pub fn conversation_id(&self) -> &str {
        &self.conversation_id
    }

    /// The value the turn hands its backend (`X-Memry-Turn`, `MEMRY_AGENT_TURN`).
    pub fn grant(&self) -> &str {
        self.grant.secret()
    }
}

impl Drop for Turn {
    fn drop(&mut self) {
        self.turns.release(&self.conversation_id);
    }
}

/// A backend in the stop and shutdown lists until it is dropped.
pub struct TrackedBackend {
    id: u64,
    turns: Weak<Turns>,
}

impl Drop for TrackedBackend {
    fn drop(&mut self) {
        if let Some(turns) = self.turns.upgrade() {
            turns.state().backends.remove(&self.id);
        }
    }
}
