import Foundation
import MemryCore

/// A `Transport` that answers from a table instead of the network.
///
/// S1 is about the FFI, not about a server. Driving `AuthSession` to
/// `Registered` is the only way to reach `TokenManager::refresh`, which is the
/// one place in the current core that holds a lock (`flight`) across a foreign
/// callback — and that is the case S1 has to observe.
final class SpikeStubTransport: Transport, @unchecked Sendable {
    /// Path suffix → (status, JSON body).
    typealias Reply = (status: UInt16, json: String)

    private let lock = NSLock()
    private var replies: [String: Reply]
    private var seen: [String] = []
    private let log: SpikeObservationLog

    init(log: SpikeObservationLog, replies: [String: Reply]) {
        self.log = log
        self.replies = replies
    }

    var requestedPaths: [String] {
        lock.lock()
        defer { lock.unlock() }
        return seen
    }

    func send(request: HttpRequest) async throws -> HttpResponse {
        log.record(SpikeCallbackObservation(seam: "Transport", method: "send(\(request.url))"))
        let path = URL(string: request.url)?.path ?? request.url
        let reply = lock.withLock { () -> Reply? in
            seen.append(path)
            return replies[path]
        }
        guard let reply else {
            throw TransportError.Failed(what: "spike stub has no reply for \(path)")
        }
        return HttpResponse(
            status: reply.status,
            headers: ["content-type": "application/json"],
            body: Data(reply.json.utf8)
        )
    }

    func openSocket(request: SocketRequest, listener: SocketListener) throws -> SocketHandle {
        throw TransportError.Failed(what: "the S1 stub does not open sockets")
    }
}

/// Unsigned JWTs whose payload segment is what the core actually reads.
///
/// `TokenClaims::parse` decodes segment 1 as base64url-without-padding JSON and
/// never verifies the signature — a client does not hold the server's key
/// (chapter 02 §2.2) — so a token minted here is enough to walk the state
/// machine. It is worthless to a real server, which is the point.
enum SpikeToken {
    static func mint(jti: String, type: String) -> String {
        let header = segment(#"{"alg":"none","typ":"JWT"}"#)
        let exp = Int(Date().addingTimeInterval(3600).timeIntervalSince1970)
        let payload = segment(
            """
            {"sub":"spike-user","jti":"\(jti)","deviceId":"spike-device",\
            "exp":\(exp),"type":"\(type)"}
            """
        )
        return "\(header).\(payload).spike-not-a-signature"
    }

    private static func segment(_ json: String) -> String {
        Data(json.utf8)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
