import Foundation

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
