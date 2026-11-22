//! `push [--vault <id>]`: one push wave, and the §11.8 poll that precedes it.
//!
//! **Why `push` and not `sync`.** A full pass would have to pull as well, and
//! this shell already has a `pull` command that does strictly more than the
//! engine's own pull half — it runs the record feed *and* chapter 07's body
//! feed. A `sync` that quietly did less than `pull` is the kind of ambiguity a
//! drill transcript cannot afford, so the write direction gets its own verb
//! and the read direction keeps the one it has. §G5's sequence is therefore
//! `notes edit`, `push`, then `pull` on the other device.
//!
//! **What it does, in order.** Chapter 11 §11.8.1 requires the policy to be
//! refreshed *immediately before draining a parked outbox* — and a client
//! cannot know its outbox is parked until it has asked, so the poll runs
//! before every drain. §11.8's point is that this is learned **without
//! attempting a write**: a flipped kill switch is visible here, on a `GET`,
//! rather than by burning an attempt on a `403`.
//!
//! **A blocked gate parks and reports failure.** No request is made, no
//! `attempt_count` moves, no row is removed (§11.9), and the command exits
//! non-zero: a parked queue is not a successful push, and a transcript that
//! said `ok` would be the whole drill's blind spot.
//!
//! The numbers it prints are the wave's own. `queued` and `attempts` are read
//! **after** the wave so the two facts T137 turns on — the rows survived, and
//! no backoff accrued — are one line each rather than an inference.

use std::fmt::Write as _;
use std::sync::Arc;

use memry_core::api::crypto::derive_vault_key;
use memry_core::api::errors::ApiError;
use memry_core::api::errors::StorageError;
use memry_core::protocol::account::{self, AccountCipher, AccountSealer, DeviceSigner};
use memry_core::protocol::http::HttpClient;
use memry_core::protocol::types::Declaration;
use memry_core::storage::Db;
use memry_core::sync::outbox;
use memry_core::sync::policy::{self, ClientPolicy, PolicyTier};
use memry_core::sync::pull::PullLoop;
use memry_core::sync::push::{PushCoordinator, PushError, PushReport};
use memry_core::sync::state::WriteGate;

use crate::commands::resolve_vault;
use crate::session::{Cli, CliError};

/// `push [--vault <id>]`.
pub async fn push(cli: &Cli, vault: Option<&str>) -> Result<(), CliError> {
    let vault = resolve_vault(cli, vault)?;
    let vault_key = derive_vault_key(cli.master_key()?)?;
    // §4.6: the id and the key that produces the signature, in one step.
    let signer = cli.device_signer()?;
    let http = cli.http()?;
    // Chapter 01 §1.7: one key opens every vault on the account, so nothing
    // cryptographic can catch a wave drained from vault A and routed to vault
    // B. The only guard is that **one** `vault` value picks the database and
    // sets `X-Memry-Vault-Id`, so the two cannot disagree.
    let db = cli.open_vault(&vault)?;

    let policy = PolicyTier::new(http.identity().app_version());
    let gate = policy::poll(&http, &policy, now_ms()).await;

    let pending = db.call_blocking(|conn| outbox::pending(conn, now_ms()))?;
    let mut outcome = Outcome {
        gate: gate.clone(),
        policy: policy.policy(),
        refused: None,
        pending,
        report: PushReport::default(),
        queued: 0,
        attempts: 0,
    };

    if gate.blocked_state().is_some() {
        // Parked. Nothing is sent, so there is nothing to report but the gate.
        finish(&db, &mut outcome)?;
        print!("{}", format_push(&outcome));
        return Err(CliError::Refused(format!(
            "writes are blocked ({}): the outbox is parked, not drained (chapter 11 §11.9)",
            gate_label(&outcome.gate)
        )));
    }

    let device_id = cli.device_id()?;
    let drained = match coordinator(http, db.clone(), &vault, vault_key, signer, &device_id).await {
        Ok(coordinator) => coordinator.drain_wave().await,
        Err(source) => Err(PushError::Api { source }),
    };
    let failure = match drained {
        Ok(report) => {
            outcome.report = report;
            None
        }
        Err(PushError::Api { source }) => {
            // §11.9: a mid-wave 403, 426 or 402 is recorded on the policy so a
            // second run parks before attempting, rather than learning the
            // same thing from a second refusal.
            policy.observe(&source);
            outcome.gate = policy.gate();
            outcome.policy = policy.policy();
            outcome.refused = Some(source.to_string());
            Some(source.to_string())
        }
        Err(error @ PushError::Storage { .. }) => return Err(CliError::Refused(error.to_string())),
    };

    finish(&db, &mut outcome)?;
    print!("{}", format_push(&outcome));
    match failure {
        None => Ok(()),
        Some(reason) => Err(CliError::Refused(reason)),
    }
}

/// What one run of the command did.
#[derive(Debug, Clone)]
pub struct Outcome {
    pub gate: WriteGate,
    /// `clientPolicy` exactly as `GET /sync/status` echoed it (§11.8).
    ///
    /// Printed beside the derived gate because they answer different
    /// questions: the gate is what this client will do, and this is what the
    /// server said. A drill that flips the kill switch needs the second one —
    /// otherwise the only evidence the switch landed is a client-side
    /// inference.
    pub policy: ClientPolicy,
    /// What a refusal said, if the wave was refused mid-flight.
    pub refused: Option<String>,
    /// Rows claimable before the wave.
    pub pending: usize,
    pub report: PushReport,
    /// Rows still in the outbox afterwards, claimable or not.
    pub queued: usize,
    /// The sum of `attempt_count` over those rows. §11.9's "no attempt accrues
    /// backoff" is this number not moving across a parked run.
    pub attempts: i64,
}

/// Reads the two after-the-fact numbers off the queue.
fn finish(db: &Db, outcome: &mut Outcome) -> Result<(), CliError> {
    outcome.queued = db.call_blocking(|conn| outbox::depth(conn))?;
    outcome.attempts = db.call_blocking(|conn| {
        conn.query_row(
            "SELECT COALESCE(SUM(attempt_count), 0) FROM outbox",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| StorageError::Failed {
            what: format!("reading the outbox attempt counts: {error}"),
        })
    })?;
    Ok(())
}

/// The gate as one word, so a transcript can be grepped.
pub fn gate_label(gate: &WriteGate) -> &'static str {
    match gate {
        WriteGate::Open => "open",
        WriteGate::ReadOnly => "read-only",
        WriteGate::BlockedUpgrade { .. } => "blocked-upgrade",
        WriteGate::Unentitled => "unentitled",
    }
}

pub fn format_push(outcome: &Outcome) -> String {
    let mut out = String::new();
    let _ = write!(
        out,
        "gate {}\nwrites-enabled {}\nmin-write-version {}\npending {}\niterations {}\naccepted {}\nrejected {}\nretired {}\ncrdt-updates {}\nbatch-ceiling {}\nhalvings {}\nqueued {}\nattempts {}\nrefused {}\ndeleted-locally {}\n",
        gate_label(&outcome.gate),
        outcome.policy.writes_enabled,
        outcome.policy.min_write_version.as_deref().unwrap_or("-"),
        outcome.pending,
        outcome.report.iterations,
        outcome.report.accepted,
        outcome.report.rejected,
        outcome.report.retired,
        outcome.report.crdt_updates,
        outcome.report.batch_ceiling,
        outcome.report.halvings,
        outcome.queued,
        outcome.attempts,
        outcome.refused.as_deref().unwrap_or("-"),
        outcome.report.deleted_locally,
    );
    out
}

/// The wave's coordinator. A `SYNC_DELETE_WINS` is checked by pulling the id,
/// and the signer directory verifies its signed delete or attested marker
/// (§5.8, #5406). Without the directory the coordinator gets no pull, so a
/// delete-wins item is deferred with its upsert queued and every other item
/// pushes. A §11.9 refusal (`403`, `426`, `402`) is returned instead, so the
/// policy learns it as from a mid-wave refusal.
async fn coordinator(
    http: Arc<HttpClient>,
    db: Db,
    vault: &str,
    vault_key: Vec<u8>,
    signer: DeviceSigner,
    device_id: &str,
) -> Result<PushCoordinator, ApiError> {
    let directory = match account::device_directory(&http).await {
        Ok(directory) => Some(directory),
        Err(error) if policy::lesson(&error).is_some() => return Err(error),
        Err(error) => {
            eprintln!(
                "memry-cli: push: the device directory could not be fetched ({error}); \
                 a delete-wins answer is deferred"
            );
            None
        }
    };
    let coordinator = PushCoordinator::new(
        http.clone(),
        db.clone(),
        Declaration::subscribed(),
        Arc::new(AccountSealer::new(vault_key.clone(), signer)),
        device_id,
    )
    .with_vault(vault);
    Ok(match directory {
        Some(directory) => {
            let cipher = Arc::new(AccountCipher::new(vault_key, directory));
            let pull = PullLoop::new(http, db, Declaration::subscribed(), cipher)
                .with_vault(vault)
                .with_clock_device(device_id);
            coordinator.with_pull(Arc::new(pull))
        }
        None => coordinator,
    })
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use memry_core::api::errors::TransportError;
    use memry_core::protocol::http::ClientIdentity;
    use memry_core::seams::transport::{
        HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
    };
    use memry_core::storage::open_data;
    use memry_core::sync::outbox::Change;
    use serde_json::json;

    /// Answers from a script, in order, and records the paths it was asked.
    struct Scripted {
        script: Mutex<VecDeque<(u16, String)>>,
        paths: Mutex<Vec<String>>,
    }

    #[async_trait::async_trait]
    impl Transport for Scripted {
        async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
            self.paths.lock().unwrap().push(request.url.clone());
            let (status, body) = self.script.lock().unwrap().pop_front().expect("scripted");
            Ok(HttpResponse {
                status,
                headers: Default::default(),
                body: body.into_bytes(),
            })
        }

        fn open_socket(
            &self,
            _request: SocketRequest,
            _listener: Arc<dyn SocketListener>,
        ) -> Result<Arc<dyn SocketHandle>, TransportError> {
            Err(TransportError::Failed {
                what: "no socket".to_string(),
            })
        }
    }

    /// A vault with live task `t1` edited locally: one upsert queued.
    fn edited_vault(label: &str) -> Db {
        let dir =
            std::env::temp_dir().join(format!("memry-cli-push-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        let db = open_data(&dir.join("data.db")).expect("open data.db");
        db.call_blocking(|conn| {
            conn.execute(
                "INSERT INTO sync_items (item_type, item_id, payload, payload_state, server_cursor,
                                         clock, updated_at)
                 VALUES ('task', 't1', '{\"title\":\"edited\"}', 'full', 5, '{\"device-b\":3}', 1)",
                [],
            )
            .map_err(|e| StorageError::Failed {
                what: e.to_string(),
            })?;
            outbox::commit(conn, &Change::upsert("task", "t1"), 1, |_| Ok(())).map(|_| ())
        })
        .expect("seed the edited row");
        db
    }

    fn count(db: &Db, sql: &'static str) -> i64 {
        db.call_blocking(move |conn| {
            conn.query_row(sql, [], |row| row.get(0))
                .map_err(|e| StorageError::Failed {
                    what: e.to_string(),
                })
        })
        .expect("count")
    }

    async fn wave_coordinator(
        db: &Db,
        script: Vec<(u16, String)>,
    ) -> (Result<PushCoordinator, ApiError>, Arc<Scripted>) {
        let transport = Arc::new(Scripted {
            script: Mutex::new(script.into()),
            paths: Mutex::new(Vec::new()),
        });
        let identity = ClientIdentity::new("ios", "1.2.3").expect("a valid identity");
        let http = Arc::new(HttpClient::new(
            transport.clone(),
            "https://sync.example",
            identity,
        ));
        let (_, secret) =
            memry_core::crypto::sodium::sign_seed_keypair(&[7u8; 32]).expect("a key pair");
        let signer = DeviceSigner::new("device-b", secret.to_vec()).expect("a signer");
        let built = coordinator(
            http,
            db.clone(),
            "vault-1",
            vec![1u8; 32],
            signer,
            "device-b",
        )
        .await;
        (built, transport)
    }

    /// C78.2 and REVIEW-5445 #1: a directory the server cannot serve does not
    /// fail the push, and a delete-wins answer is deferred unchecked: the
    /// upsert stays queued, nothing is deleted or flagged, no pull is made.
    #[tokio::test]
    async fn without_the_directory_a_delete_wins_item_is_deferred_and_the_wave_succeeds() {
        let db = edited_vault("no-directory");
        let delete_wins = json!({"accepted": [], "serverTime": 1, "maxCursor": 1,
                                 "rejected": [{"id": "t1", "reason": "SYNC_DELETE_WINS"}]});
        let (built, transport) = wave_coordinator(
            &db,
            vec![
                (404, r#"{"error":"NOT_FOUND"}"#.to_string()),
                (200, delete_wins.to_string()),
            ],
        )
        .await;
        let report = built
            .expect("a coordinator")
            .drain_wave()
            .await
            .expect("the wave succeeds");
        assert_eq!(report.rejected, 1);
        assert!(
            !transport
                .paths
                .lock()
                .unwrap()
                .iter()
                .any(|p| p.contains("/sync/pull")),
            "no by-id pull without a directory"
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM outbox WHERE last_error IS NOT NULL"
            ),
            1,
            "the upsert stays queued"
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM sync_items WHERE deleted_at IS NULL AND corrupt_reason IS NULL"
            ),
            1,
            "the row is neither deleted nor flagged"
        );
    }

    /// REVIEW-5445 #5: a §11.9 refusal on the directory fetch reaches the
    /// caller, which records it on the policy and fails the push.
    #[tokio::test]
    async fn a_refusal_on_the_directory_fetch_is_returned() {
        let db = edited_vault("refused");
        let (built, _) = wave_coordinator(
            &db,
            vec![(
                426,
                r#"{"error":{"code":"CLIENT_UPGRADE_REQUIRED","message":"upgrade"}}"#.to_string(),
            )],
        )
        .await;
        let error = built.err().expect("a refusal");
        assert!(policy::lesson(&error).is_some(), "{error}");
        assert_eq!(count(&db, "SELECT COUNT(*) FROM outbox"), 1);
    }

    fn outcome(gate: WriteGate) -> Outcome {
        Outcome {
            gate,
            policy: ClientPolicy::default(),
            refused: None,
            pending: 1,
            report: PushReport::default(),
            queued: 1,
            attempts: 0,
        }
    }

    #[test]
    fn a_parked_run_prints_the_gate_the_surviving_rows_and_an_unmoved_attempt_count() {
        let rendered = format_push(&outcome(WriteGate::ReadOnly));
        // The three facts T137 turns on.
        assert!(rendered.contains("gate read-only"), "{rendered}");
        assert!(rendered.contains("queued 1"), "{rendered}");
        assert!(rendered.contains("attempts 0"), "{rendered}");
        // And the absence of a push: nothing was attempted, so nothing was
        // accepted and no iteration ran.
        assert!(rendered.contains("iterations 0"), "{rendered}");
        assert!(rendered.contains("accepted 0"), "{rendered}");
    }

    #[test]
    fn the_kill_switch_is_printed_as_the_server_said_it_and_not_only_as_a_gate() {
        let mut parked = outcome(WriteGate::ReadOnly);
        parked.policy = ClientPolicy {
            platform: Some("ios".to_string()),
            writes_enabled: false,
            min_write_version: None,
        };
        let rendered = format_push(&parked);
        // T137 turns on this line: the server's own `clientPolicy`, learned on
        // a `GET` without attempting a write (§11.8).
        assert!(rendered.contains("writes-enabled false"), "{rendered}");
        assert!(rendered.contains("min-write-version -"), "{rendered}");

        // §11.7.1: the version floor is its own input and prints separately,
        // so a `426` can never be read off this transcript as a kill switch.
        let mut floored = outcome(WriteGate::BlockedUpgrade {
            min_version: Some("9.9.9".to_string()),
        });
        floored.policy = ClientPolicy {
            platform: Some("ios".to_string()),
            writes_enabled: true,
            min_write_version: Some("9.9.9".to_string()),
        };
        let rendered = format_push(&floored);
        assert!(rendered.contains("writes-enabled true"), "{rendered}");
        assert!(rendered.contains("min-write-version 9.9.9"), "{rendered}");
    }

    #[test]
    fn the_four_gates_print_four_different_words() {
        // §11.7.1: three blocked states that never collapse, plus the open
        // one. A transcript that spelled two of them the same way would make
        // the drill unfalsifiable.
        let labels = [
            gate_label(&WriteGate::Open),
            gate_label(&WriteGate::ReadOnly),
            gate_label(&WriteGate::BlockedUpgrade {
                min_version: Some("2.0.0".to_string()),
            }),
            gate_label(&WriteGate::Unentitled),
        ];
        let mut unique = labels.to_vec();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), labels.len(), "{labels:?}");
    }

    #[test]
    fn a_refusal_is_printed_and_a_clean_wave_prints_a_dash() {
        assert!(format_push(&outcome(WriteGate::Open)).contains("refused -"));

        let mut refused = outcome(WriteGate::Unentitled);
        refused.refused = Some("SYNC_PAYMENT_REQUIRED".to_string());
        let rendered = format_push(&refused);
        assert!(
            rendered.contains("refused SYNC_PAYMENT_REQUIRED"),
            "{rendered}"
        );
    }

    /// #5373: the plan's vault cap is a `PaymentRequired` on every sync route,
    /// so the transcript says the plan is full instead of a bare `402`.
    #[test]
    fn a_vault_limit_refusal_prints_as_needing_a_plan() {
        let source = memry_core::api::errors::ApiError::PaymentRequired {
            code: Some("SYNC_VAULT_LIMIT_EXCEEDED".to_string()),
            message: "plus allows 1 synced vaults".to_string(),
        };
        let mut refused = outcome(WriteGate::Open);
        refused.refused = Some(source.to_string());
        let rendered = format_push(&refused);
        assert!(
            rendered.contains("refused sync needs a plan: plus allows 1 synced vaults"),
            "{rendered}"
        );
    }

    #[test]
    fn a_drained_wave_prints_every_count_the_report_carries() {
        let mut drained = outcome(WriteGate::Open);
        drained.report = PushReport {
            iterations: 2,
            accepted: 7,
            rejected: 1,
            retired: 1,
            crdt_updates: 3,
            batch_ceiling: 50,
            halvings: 1,
            deleted_locally: 2,
        };
        drained.queued = 1;
        drained.attempts = 1;
        let rendered = format_push(&drained);
        for expected in [
            "iterations 2",
            "accepted 7",
            "rejected 1",
            "retired 1",
            "crdt-updates 3",
            // §5.6: a halved ceiling is a property of the run and stays down,
            // so a transcript that omitted it would hide why the next wave
            // sends fifty.
            "batch-ceiling 50",
            "halvings 1",
            "deleted-locally 2",
        ] {
            assert!(
                rendered.contains(expected),
                "{expected} missing: {rendered}"
            );
        }
    }
}
