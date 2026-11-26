import MemryCore

// The first sync's diagnostic lines, split from `VaultFillViewModel.swift`.

extension VaultFillViewModel {
    /// One diagnostic line per phase, not per tick. `scripts/bootstrap-bench`
    /// reads "the first sync is pulling bodies" as its records mark.
    static func logReached(_ progress: SyncProgress) {
        let total = LogDetail.count(Int(progress.total ?? progress.completed))
        switch progress.phase {
        case .records: Log.sync.notice("the first sync is pulling records", total)
        case .bodies: Log.sync.notice("the first sync is pulling bodies", total)
        case .done: Log.sync.notice("the first sync is finishing", total)
        }
    }
}
