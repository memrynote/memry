import Foundation

// Shared plumbing for the on-device conformance vector harness.
//
// The three governing rules live in
// `packages/contracts/test-vectors/README.md`. The one that shapes this file is
// rule 2: **verification is a separate program from generation.** Nothing here
// regenerates a vector, computes an expectation, or imports a builder. The
// committed JSON is the input and the only input.
//
// The files are reached **in place**: `MemryConformanceTests` copies the folder
// reference `../../packages/contracts/test-vectors` into the test bundle at
// build time, so there is exactly one copy of each vector in the repository.
// Checking a second copy in under `apps/ios/` would create an artefact that can
// drift from the first, and a drift no gate can see is the failure mode the
// whole vector scheme exists to prevent. Swift has no `include_str!`, so the
// copy happens at build time instead of at compile time; the source of truth is
// the same file the Rust harness compiles in.

/// Anchors `Bundle(for:)` on the test bundle rather than on the host app.
private final class BundleMarker {}

/// The directory the folder reference lands in inside the `.xctest` bundle.
private let vectorsSubdirectory = "test-vectors"

/// Every committed vector class this target can reach through the FFI.
///
/// A class is absent here only because the exported surface cannot reach it
/// (`specs/002-native-foundation-ios/contracts/core-api.md`), never because it
/// was inconvenient.
enum VectorFiles {
    static let bip39Unlock: Bip39UnlockVectors = load("bip39-unlock")
    static let compression: CompressionVectors = load("compression")
    static let cryptoVectors: CryptoVectors = load("crypto-vectors")
    static let recordEnvelope: RecordEnvelopeVectors = load("record-envelope")
    static let noteBlocks: NoteBlocksVectors = load("note-blocks")

    private static func load<T: Decodable>(_ name: String) -> T {
        let bundle = Bundle(for: BundleMarker.self)
        guard
            let url = bundle.url(
                forResource: name,
                withExtension: "json",
                subdirectory: vectorsSubdirectory
            )
        else {
            fatalError(
                """
                \(name).json is not in the test bundle. The MemryConformanceTests \
                target copies packages/contracts/test-vectors as a folder reference; \
                a missing file means that copy phase was dropped, and a suite that \
                cannot find its input must not pass.
                """
            )
        }
        do {
            return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
        } catch {
            fatalError("\(name).json did not decode into \(T.self): \(error)")
        }
    }
}

/// Every vector file's header. `caseCount` is what makes "the suite ran every
/// case the file declares" an assertion rather than a hope.
struct VectorMeta: Codable, Sendable {
    let caseCount: Int
}

// MARK: - bip39-unlock.json

struct Bip39UnlockVectors: Codable, Sendable {
    let meta: VectorMeta
    let bip39: [PhraseCase]
    let verifiers: [VerifierCase]

    /// A recovery-phrase case: valid, invalid, or one that only becomes valid
    /// after the five normalisation steps of chapter 01 §1.3.
    struct PhraseCase: Codable, Sendable, CustomStringConvertible {
        let name: String
        let mnemonic: String
        let wordCount: Int?
        let canonicalised: String?
        let expectedValid: Bool?

        var description: String { name }
    }

    /// One of four shapes, told apart by which key is present — the same
    /// dispatch the Rust harness does.
    struct VerifierCase: Codable, Sendable, CustomStringConvertible {
        let name: String
        let mnemonic: String?
        let kdfSaltHex: String?
        let expectedMasterKeyHex: String?
        let expectedVaultKeyHex: String?
        let expectedAccountKeyVerifierB64: String?
        let serverVerifierB64: String?
        let expectedMatch: Bool?
        let masterKeyHex: String?
        let expectedB64: String?
        let vaultKeyHex: String?
        let vaultId: String?
        let ed25519PublicKeyHex: String?
        let expectedDeviceIdHex: String?

        var description: String { name }
    }
}

// MARK: - compression.json

struct CompressionVectors: Codable, Sendable {
    let meta: VectorMeta
    let cases: [FrameCase]
    let readerCases: [ReaderCase]
    let errorCases: [ErrorCase]

    struct FrameCase: Codable, Sendable, CustomStringConvertible {
        let name: String
        let inputHex: String
        let inputBytes: Int
        let expectedFlag: Int?
        let expectedFrameHex: String
        let expectedInflatedHex: String

        var description: String { name }
    }

    struct ReaderCase: Codable, Sendable, CustomStringConvertible {
        let name: String
        let frameHex: String
        let expectedInflatedHex: String

        var description: String { name }
    }

    struct ErrorCase: Codable, Sendable, CustomStringConvertible {
        let name: String
        let frameHex: String

        var description: String { name }
    }
}

// MARK: - crypto-vectors.json

struct CryptoVectors: Codable, Sendable {
    let kdfDeriveFromKey: [KdfRow]
    let ed25519: Ed25519
    let vaultUnlockFlow: VaultUnlockFlow

    /// The two context names the exported surface derives for us. The other
    /// rows in the group need a raw `crypto_kdf_derive_from_key`, which is not
    /// exported and must not be invented for a test's convenience.
    static let reachableContextNames = ["memry-vault-key-v1", "memry-key-verifier-v1"]

    var reachableKdfRows: [KdfRow] {
        kdfDeriveFromKey.filter { Self.reachableContextNames.contains($0.contextName) }
    }

    struct KdfRow: Codable, Sendable, CustomStringConvertible {
        let contextName: String
        let subkeyId: Int
        let length: Int
        let masterKeyHex: String
        let derivedHex: String

        var description: String { contextName }
    }

    struct Ed25519: Codable, Sendable {
        let publicKeyHex: String
        let deviceIdHex: String
    }

    struct VaultUnlockFlow: Codable, Sendable {
        let masterKeyHex: String
        let keyVerifierBase64: String
        let vaultKeyHex: String
    }
}

// MARK: - record-envelope.json

struct RecordEnvelopeVectors: Codable, Sendable {
    let cases: [EnvelopeCase]

    struct EnvelopeCase: Codable, Sendable, CustomStringConvertible {
        let name: String
        let input: Input
        let expected: Expected

        var description: String { name }

        struct Input: Codable, Sendable {
            let contentUtf8: String
        }

        struct Expected: Codable, Sendable {
            let compressedHex: String
        }
    }
}

// MARK: - note-blocks.json

/// The read-direction block walk: document bytes in, the block list this shell
/// renders out.
///
/// Reached through `blocksFromUpdate`, which is the same walk `Notes.blocks`
/// runs without needing an opened vault. The class exists because the only
/// other test holding the walk compared it against the *text* walk of the same
/// port \u2014 two readings that agree with each other whether or not either is
/// right, which is how dropping `divider` went unnoticed.
struct NoteBlocksVectors: Codable, Sendable {
    let meta: VectorMeta
    let cases: [BlockCase]

    struct BlockCase: Codable, Sendable, CustomStringConvertible {
        let name: String
        let pins: String
        let updateHex: String
        let expectedBlocks: [ExpectedBlock]
        let expectedCanonical: String

        var description: String { name }
    }

    /// The committed shape of one block.
    ///
    /// Declared here rather than decoded into the FFI's own `Block`: the file
    /// is the contract, and decoding straight into the generated type would
    /// let a field rename pass by renaming both sides at once.
    struct ExpectedBlock: Codable, Sendable {
        let id: String?
        let kind: String
        let depth: UInt32
        let props: [ExpectedProp]
        let inline: [ExpectedRun]
    }

    struct ExpectedProp: Codable, Sendable {
        let name: String
        let value: String
    }

    struct ExpectedRun: Codable, Sendable {
        let text: String
        let marks: [String]
        let markAttrs: [String: String]
        let target: String?
    }
}

// MARK: - hex

extension Data {
    /// Decodes a vector's hex field.
    ///
    /// Traps rather than returning `nil`: a hex field that is not hex means the
    /// committed input is broken, which is not a result a test should report as
    /// a failed expectation and carry on from.
    init(hex: String) {
        var bytes: [UInt8] = []
        bytes.reserveCapacity(hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            guard
                let next = hex.index(index, offsetBy: 2, limitedBy: hex.endIndex),
                let byte = UInt8(hex[index..<next], radix: 16)
            else {
                fatalError("vector field is not hex: \(hex)")
            }
            bytes.append(byte)
            index = next
        }
        self.init(bytes)
    }

    var hexString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}
