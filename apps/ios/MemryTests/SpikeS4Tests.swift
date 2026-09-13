import Foundation
import MemryCore
import Testing

// B0 spike S4, task T082, gate G3a.
//
// The question: does Argon2id at 64 MiB, ops 3 fail to allocate on a physical
// iPhone under memory pressure, and is that `-1` distinguishable from a wrong
// recovery phrase? Reporting an allocation failure as "wrong phrase" tells a
// user to re-type a phrase that was correct (research R3).
//
// This file MUST run on a device. `aarch64-apple-ios-sim` runs on the host CPU
// with host memory and links a different libsodium, so the derivation always
// succeeds there and the answer would be worth nothing. The pressure test
// refuses to make a claim when it is not on a device.
@Suite("S4 — Argon2id under memory pressure, on hardware")
struct SpikeS4Tests {
    /// From `bip39-unlock.json`: a checksum-valid 24-word mnemonic.
    static let validPhrase = """
    audit vapor excuse note pledge rough bundle start regular burden reveal theme \
    bachelor bag speed print guess session grit first smoke urge save bicycle
    """

    /// The same phrase with its last word changed: every word is real, the
    /// checksum is not. This is what "wrong phrase" looks like.
    static let badChecksumPhrase = """
    audit vapor excuse note pledge rough bundle start regular burden reveal theme \
    bachelor bag speed print guess session grit first smoke urge save zoo
    """

    static let salt = Data(repeating: 0x2b, count: 16)

    static var isDevice: Bool {
        #if targetEnvironment(simulator)
            return false
        #else
            return true
        #endif
    }

    @Test("the 64 MiB derivation succeeds on hardware with no pressure")
    func baseline() throws {
        let key = try deriveMasterKey(phrase: Self.validPhrase, kdfSalt: Self.salt)
        #expect(key.count == 32)
        SpikeReport.emit("S4/baseline", [
            "device=\(Self.isDevice)",
            "keyBytes=\(key.count)"
        ])
    }

    @Test("a wrong phrase is a phrase error, never a crypto error")
    func wrongPhraseIsItsOwnOutcome() {
        do {
            _ = try deriveMasterKey(phrase: Self.badChecksumPhrase, kdfSalt: Self.salt)
            Issue.record("a bad checksum must not derive a key")
        } catch let error as RecoveryError {
            // The whole point: this arm and the allocation arm are different
            // values, so a shell can say different things to the user.
            switch error {
            case .BadChecksum, .UnknownWord, .WrongWordCount, .NonAscii, .VerifierMismatch:
                SpikeReport.emit("S4/wrongPhrase", ["error=\(error)"])
            case .Crypto:
                Issue.record("a wrong phrase surfaced as a crypto failure: \(error)")
            }
        } catch {
            Issue.record("unexpected error type: \(error)")
        }
    }

    /// Gated with `.enabled(if:)` and **not** with `try #require(Self.isDevice)`.
    /// They are not two spellings of the same thing: `#require` records an
    /// *expectation failure* when its condition is false, so the off-device
    /// form failed this test on every simulator run — which is what kept iOS CI
    /// red on `main` after spec-defect 112 was believed closed. A trait removes
    /// the test from the run and reports it as **skipped**, which is the
    /// distinction the whole file rests on: a simulator must never be able to
    /// read as this having held, and it must never read as this having failed
    /// either.
    @Test(
        "under memory pressure the derivation either succeeds or fails as Crypto — never as a phrase error",
        .enabled(if: SpikeS4Tests.isDevice, "S4 is only evidence on hardware; the simulator uses host memory")
    )
    func pressureNeverLooksLikeAWrongPhrase() throws {

        // Squeeze the process until the 64 MiB Argon2id arena is contended.
        // Touched, not merely reserved: iOS only commits a page that is written.
        var ballast: [UnsafeMutableRawPointer] = []
        defer { for block in ballast { free(block) } }
        let blockBytes = 64 * 1024 * 1024
        // Bounded at 1.5 GiB **on purpose**, and the bound is the finding.
        //
        // An unbounded run was performed once: the process was killed by iOS
        // (jetsam, "Test crashed with signal kill") before `malloc` ever
        // refused, taking every other test in the process with it. So the
        // failure mode T082 asks about — `crypto_pwhash` returning -1 because
        // it could not allocate 64 MiB — is **not reachable on iOS through
        // memory pressure**: the app dies first. That run is recorded in
        // research.md §Addenda S4 and is not repeated here, because a suite
        // that jetsams itself proves the point once and then only destroys
        // unrelated evidence.
        //
        // What this bounded run still proves, and proves repeatably, is the
        // other half: at 1.5 GiB of touched ballast the 64 MiB derivation
        // completes, and no outcome of it is ever reported as a phrase error.
        while ballast.count < 24 {
            guard let block = malloc(blockBytes) else { break }
            memset(block, 0xa5, blockBytes)
            ballast.append(block)
        }

        var outcome = "succeeded"
        do {
            let key = try deriveMasterKey(phrase: Self.validPhrase, kdfSalt: Self.salt)
            #expect(key.count == 32)
        } catch let error as RecoveryError {
            switch error {
            case .Crypto:
                // The answer T082 asks for: an allocation failure arrives as a
                // crypto variant and is distinguishable from a wrong phrase.
                outcome = "Crypto(\(error))"
            default:
                Issue.record(
                    """
                    an allocation failure surfaced as a phrase error — a user would be told to \
                    re-type a correct phrase: \(error)
                    """
                )
                outcome = "MISREPORTED(\(error))"
            }
        }

        SpikeReport.emit("S4/pressure", [
            "ballastBlocks=\(ballast.count)",
            "ballastMiB=\(ballast.count * 64)",
            "outcome=\(outcome)"
        ])
    }
}

/// Was in `SpikeTests.swift`, which went with the rest of the B0 scaffolding
/// when phase C1 replaced it (`Memry/Spikes/README.md`'s own instruction). It
/// lives here now because S4 is the one spike still outstanding: T082 is
/// recorded BLOCKED only because no physical iPhone was available, and one is
/// now. Keeping the harness makes closing T082 nearly free during the T161/T162
/// device session; deleting it would have made a decision nobody took.
enum SpikeReport {
    static func emit(_ label: String, _ lines: [String]) {
        FileHandle.standardError.write(Data(
            (["[spike \(label)]"] + lines.map { "  \($0)" }).joined(separator: "\n").appending("\n").utf8
        ))
    }
}
