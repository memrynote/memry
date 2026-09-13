import Foundation
import MemryCore

// T165. Where T148's token exchange goes.
//
// `GoogleSignIn.init` requires a transport and constructs no `URLSession`,
// because `pnpm check:architecture` refuses one outside `Memry/Seams/` — a
// second network path is one the core cannot see, cannot retry and cannot
// kill-switch. T148 left the decision of what satisfies that to whoever wired
// the flow up. This is that decision.
//
// **It is not a new seam.** A file under `Memry/Seams/` with its own
// `URLSession` would pass the gate and defeat the rule the gate exists for:
// the process would hold two sessions, two connection pools and two sets of
// timeouts, and the second one would be invisible to everything that reasons
// about this app's network use. Instead the exchange goes through the **same**
// `Transport` the core drives — the one `URLSessionTransport` that
// `AuthComposition` already builds and hands to `AuthSession`. One session,
// one seam, one place a request can be observed or stopped.
//
// **The core is not asked to drive it.** `POST https://oauth2.googleapis.com/token`
// is Google's endpoint, not Memry's: it takes no Memry token, belongs to no
// chapter of `docs/protocol/`, and routing it through `HttpClient` would put
// a foreign host inside the base-URL, auth-header and retry-ladder machinery
// that exists for one server. The seam is the shared thing; the policy above
// it is not.
//
// Nothing here is logged. The body carries an authorization code and a PKCE
// verifier, and `Log`'s surface is a `StaticString` plus a closed `LogDetail`,
// so there is nowhere to put either even by accident.

enum GoogleTokenExchange {
    /// Chapter 00 §0.6 makes a per-request ceiling mandatory and the seam
    /// applies this one as `URLRequest.timeoutInterval`. Thirty seconds is the
    /// platform default for a foreground request; a token exchange that has not
    /// answered by then is not going to.
    static let timeoutMs: UInt64 = 30_000

    /// Adapts the one `Transport` to the exchange closure T148 declared.
    ///
    /// The `URLRequest` in and the `HTTPURLResponse` out are value types with
    /// no loading behaviour of their own — neither opens a connection — so the
    /// only thing that reaches the network is `transport.send`.
    static func through(_ transport: any Transport) -> GoogleSignIn.Exchange {
        { request in
            guard let url = request.url else {
                throw GoogleSignInFailure.transportFailed
            }
            let sent = HttpRequest(
                method: request.httpMethod ?? "POST",
                url: url.absoluteString,
                // Lowercase in both directions, from the seam's contract.
                headers: (request.allHTTPHeaderFields ?? [:])
                    .reduce(into: [String: String]()) { $0[$1.key.lowercased()] = $1.value },
                body: request.httpBody,
                timeoutMs: timeoutMs
            )
            let received = try await transport.send(request: sent)
            // A non-2xx is a **response**, exactly as it is for the seam: the
            // flow reads the status to decide whether a retry could ever work,
            // and a refusal turned into a thrown transport failure here would
            // make `tokenExchangeRefused(status:)` unreachable.
            guard let head = HTTPURLResponse(
                url: url,
                statusCode: Int(received.status),
                httpVersion: "HTTP/1.1",
                headerFields: received.headers
            ) else {
                throw GoogleSignInFailure.tokenExchangeUnreadable
            }
            return (received.body, head)
        }
    }
}
