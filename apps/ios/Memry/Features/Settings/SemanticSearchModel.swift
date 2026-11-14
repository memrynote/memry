import Foundation
import MemryCore
import Observation
import SwiftUI

extension EnvironmentValues {
    @Entry var semanticSearch: (any SemanticSearchProtocol)?
}

struct SemanticSearchDisplay: Equatable {
    enum Row: Equatable {
        case progress(title: String, detail: String, fraction: Double)
        case failed(title: String, guidance: String)
        case ready(indexed: String)
    }

    enum Pending: Equatable { case enabling, disabling }

    let isOn: Bool
    let row: Row?
    let size: String

    init(_ status: SemanticStatus, pending: Pending? = nil) {
        size = Self.bytes(status.downloadBytes)
        switch pending {
        case .enabling: isOn = true
        case .disabling: isOn = false
        case nil: isOn = status.model != .off
        }
        row = pending == .disabling ? nil : Self.row(status)
    }

    private static func row(_ status: SemanticStatus) -> Row? {
        switch status.model {
        case .off:
            nil
        case let .downloading(received, total):
            .progress(
                title: SemanticSearchCopy.downloading,
                detail: SemanticSearchCopy.progress(received: bytes(received), total: bytes(total)),
                fraction: fraction(received, total)
            )
        case let .waitingForWifi(received, total):
            .progress(
                title: SemanticSearchCopy.waitingForWifi,
                detail: SemanticSearchCopy.paused(received: bytes(received), total: bytes(total)),
                fraction: fraction(received, total)
            )
        case let .failed(_, _, failure):
            failed(failure)
        case .ready:
            .ready(indexed: SemanticSearchCopy.indexedCount(status.embeddedNotes, of: status.totalNotes))
        }
    }

    private static func failed(_ failure: DownloadFailure) -> Row {
        switch failure {
        case .mismatch: .failed(title: SemanticSearchCopy.damagedTitle, guidance: SemanticSearchCopy.damagedGuidance)
        case .http: .failed(title: SemanticSearchCopy.serverTitle, guidance: SemanticSearchCopy.serverGuidance)
        case .network: .failed(title: SemanticSearchCopy.networkTitle, guidance: SemanticSearchCopy.networkGuidance)
        case .storage: .failed(title: SemanticSearchCopy.storageTitle, guidance: SemanticSearchCopy.storageGuidance)
        }
    }

    private static func fraction(_ received: UInt64, _ total: UInt64) -> Double {
        total == 0 ? 0 : min(1, Double(received) / Double(total))
    }

    private static func bytes(_ count: UInt64) -> String {
        ByteCountFormatter.memry(Int64(clamping: count))
    }
}

@MainActor
@Observable
final class SemanticSearchModel {
    private let semantic: any SemanticSearchProtocol
    private let vault: Vault
    private let executor: CoreExecutor
    private let availableBytes: @Sendable () throws -> UInt64

    private(set) var status: SemanticStatus?
    private(set) var pending: SemanticSearchDisplay.Pending?
    private(set) var failure: UserFacingError?

    init(
        semantic: any SemanticSearchProtocol,
        vault: Vault,
        executor: CoreExecutor,
        availableBytes: @escaping @Sendable () throws -> UInt64
    ) {
        self.semantic = semantic
        self.vault = vault
        self.executor = executor
        self.availableBytes = availableBytes
    }

    var display: SemanticSearchDisplay? {
        status.map { SemanticSearchDisplay($0, pending: pending) }
    }

    func refresh() async {
        let semantic = semantic, vault = vault
        do {
            let next = try await executor.run { semantic.status(vault: vault) }
            status = next
            if pending == .enabling, next.model != .off { pending = nil }
        } catch {
            Log.core.error("semantic search status could not be read", .code(ErrorMapping.userFacing(error).code))
        }
    }

    func turnOn() async {
        pending = .enabling
        failure = nil
        do {
            _ = try await semantic.enable(availableBytes: availableBytes())
        } catch {
            failure = mapped(error)
        }
        if pending == .enabling { pending = nil }
        await refresh()
    }

    func turnOff() async {
        pending = .disabling
        failure = nil
        do {
            try await semantic.disable(vault: vault)
        } catch {
            failure = mapped(error)
        }
        pending = nil
        await refresh()
    }

    private func mapped(_ error: any Error) -> UserFacingError {
        let mapped = ErrorMapping.userFacing(error)
        Log.core.error("a semantic search settings call failed", .code(mapped.code))
        return mapped
    }
}
