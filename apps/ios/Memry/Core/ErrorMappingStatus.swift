import Foundation
import MemryCore

// A 4xx the client has no specific policy for. It must **not** read as
// transient: a permanently rejected record wedges the outbox and retries
// forever, so "try again" here would describe a loop as a fix.
//
// #5373: the status and the server's code close the sentence, so a user can
// read out which refusal it was. Without them nobody could tell.
extension ErrorMapping {
    static func serverRefusal(_ status: UInt16, _ code: String?) -> UserFacingError {
        let reply = serverCode(code).map { "\(status) \($0)" } ?? "\(status)"
        return UserFacingError(
            code: "api.statusRefused",
            title: "The Memry server refused that request.",
            guidance: "Repeating it will not change the answer. Updating Memry may fix it. Server reply: \(reply).",
            recourse: .blocked,
            isUserVisible: true
        )
    }

    /// The contract's `SERVER_ERROR_CODE` (`^[A-Z][A-Z0-9_]{0,63}$`), or `nil`.
    /// Only a code in that grammar may reach a sentence or telemetry: it is a
    /// server enum name, never a payload, and one bad telemetry field makes the
    /// server reject the whole batch.
    static func serverCode(_ code: String?) -> String? {
        guard let code, let first = code.unicodeScalars.first, code.unicodeScalars.count <= 64,
              ("A" ... "Z").contains(first),
              code.unicodeScalars.allSatisfy({ ("A" ... "Z").contains($0) || ("0" ... "9").contains($0) || $0 == "_" })
        else { return nil }
        return code
    }
}

/// #5373: the plan's vault cap refused a sync pass, with the name of the vault
/// that is not syncing. Only the filler knows which vault it syncs, so it
/// names the refusal there; every screen that reports a pass then says which
/// vault without knowing about vaults.
struct VaultPlanFull: Error, Equatable {
    let vaultName: String

    /// `error` itself unless it is the vault cap's 402, bare or inside
    /// `SyncError.Api`.
    static func naming(_ vaultName: String, in error: any Error) -> any Error {
        let api = (error as? ApiError) ?? {
            if case let .Api(source) = error as? SyncError { return source }
            return nil
        }()
        guard case let .PaymentRequired(code, _) = api, code == "SYNC_VAULT_LIMIT_EXCEEDED" else {
            return error
        }
        return VaultPlanFull(vaultName: vaultName)
    }
}

extension ErrorMapping {
    /// The vault's name is the user's own label, already on screen, so the
    /// sentence may carry it, as a property's name does (#4649).
    static func userFacing(_ error: VaultPlanFull) -> UserFacingError {
        UserFacingError(
            code: "api.vaultLimitReached",
            title: "\u{201C}\(error.vaultName)\u{201D} is not syncing: your plan has no room for another synced vault.",
            guidance: "It stays on this \(ThisDevice.noun). "
                + "Choose a larger plan, or delete a vault you no longer sync.",
            recourse: .blocked,
            isUserVisible: true
        )
    }
}
