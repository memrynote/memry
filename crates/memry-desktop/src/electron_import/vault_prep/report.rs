//! A prepared vault's section of the migration report (`electron-import-report.json`): every
//! journal entry not applied and every document not imported is listed, with the reason. Note
//! ids and vault-relative paths only; never note text.

use serde::Serialize;

use super::{PreparedVault, VaultIds, tree};
use crate::electron_import::journal_replay::EntrySkip;
use crate::electron_import::ystore_import::{LegacyStore, SkipReason};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultPrepReport {
    pub ids: VaultIds,
    pub replay: ReplayReport,
    pub fold: FoldReport,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayReport {
    /// Vault-relative.
    pub written: Vec<String>,
    pub deleted: Vec<String>,
    pub settled: usize,
    pub skipped: Vec<SkippedEntry>,
    pub other_vault: usize,
    pub unknown: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedEntry {
    /// Position in the journal's `entries`.
    pub index: usize,
    /// `absolutePath` as Electron recorded it.
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoldReport {
    pub docs: usize,
    /// `unreadable` ones re-seed from their markdown when first opened, as Electron does
    /// (`crdt-provider.ts:944-950`).
    pub skipped: Vec<SkippedDoc>,
    pub incomplete: Vec<String>,
    pub legacy: &'static str,
    pub previous_store_unread: bool,
    pub ignored_keys: usize,
    pub torn_tails: Vec<TornTail>,
    pub owed_compactions: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedDoc {
    pub doc_id: String,
    pub reason: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TornTail {
    pub file: String,
    pub offset: usize,
    pub dropped_bytes: usize,
}

pub(super) fn of(vault: &PreparedVault) -> VaultPrepReport {
    let rel = |paths: &[std::path::PathBuf]| -> Vec<String> {
        paths
            .iter()
            .filter_map(|p| p.strip_prefix(&vault.dir).ok())
            .map(tree::key)
            .collect()
    };
    let replay = &vault.replay;
    let fold = &vault.fold;
    VaultPrepReport {
        ids: vault.ids.clone(),
        replay: ReplayReport {
            written: rel(&replay.written),
            deleted: rel(&replay.deleted),
            settled: replay.settled,
            skipped: replay
                .skipped
                .iter()
                .map(|s| SkippedEntry {
                    index: s.index,
                    path: s.path.clone(),
                    reason: entry_skip(&s.reason),
                })
                .collect(),
            other_vault: replay.other_vault,
            unknown: vault.journal_unknown,
        },
        fold: FoldReport {
            docs: fold.docs.len(),
            skipped: fold
                .skipped
                .iter()
                .map(|s| SkippedDoc {
                    doc_id: s.doc_id.clone(),
                    reason: doc_skip(s.reason),
                })
                .collect(),
            incomplete: fold.incomplete.clone(),
            legacy: legacy(fold.legacy),
            previous_store_unread: fold.previous_store_unread,
            ignored_keys: fold.ignored_keys,
            torn_tails: fold
                .torn_tails
                .iter()
                .map(|t| TornTail {
                    file: t.file.clone(),
                    offset: t.offset,
                    dropped_bytes: t.dropped_bytes,
                })
                .collect(),
            owed_compactions: fold.owed_compactions.clone(),
        },
    }
}

fn entry_skip(reason: &EntrySkip) -> String {
    match reason {
        EntrySkip::ShaMismatch => "shaMismatch".to_owned(),
        EntrySkip::UnsafePath => "unsafePath".to_owned(),
        EntrySkip::NewerOnDisk => "newerOnDisk".to_owned(),
        EntrySkip::WriteFailed(kind) => format!("writeFailed: {kind}"),
    }
}

fn doc_skip(reason: SkipReason) -> &'static str {
    match reason {
        SkipReason::Reserved => "reserved",
        SkipReason::Unattributable => "unattributable",
        SkipReason::AmbiguousLegacy => "ambiguousLegacy",
        SkipReason::Empty => "empty",
        SkipReason::Unreadable => "unreadable",
    }
}

fn legacy(store: LegacyStore) -> &'static str {
    match store {
        LegacyStore::Absent => "absent",
        LegacyStore::Read => "read",
        LegacyStore::ClaimedByOther => "claimedByOther",
        LegacyStore::LeftUnread => "leftUnread",
    }
}
