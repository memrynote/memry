import Foundation
import MemryCore
import Testing

// The on-device conformance tier (gate G3, SC-001): the committed vector files
// under `packages/contracts/test-vectors/`, run through the real FFI.
//
// Two things this tier is NOT:
//
//  1. **It is not evidence for the `aarch64-apple-ios` crypto build.** T093 and
//     `research.md` §Addenda both say so. A run here executes the
//     `aarch64-apple-ios-sim` slice of `MemryCoreFFI.xcframework` on the host
//     CPU; the device slice is a different binary and only a device run
//     exercises it.
//  2. **It is not a Swift reimplementation.** Every expectation below is a
//     value the committed JSON already contains, and every value it is compared
//     against comes out of `MemryCore`. A failure here is a **protocol
//     question** until proved otherwise: the JSON came out of a production
//     TypeScript path, so "the vector is wrong" is the last hypothesis to reach
//     for, not the first.
//
// The exported surface is ten functions
// (`specs/002-native-foundation-ios/contracts/core-api.md`). Four committed
// classes are reachable through it and are covered here; the rest —
// `cbor-canonical`, `crdt-update`, `field-merge`, `pack-container`,
// `payload-schemas`, `device-linking`, `text-extract`,
// `markdown-roundtrip` — have no exported entry point yet, and no export was
// invented to make one testable.

// MARK: - bip39-unlock.json

@Suite("bip39-unlock.json — chapter 01, the recovery-phrase chain")
struct Bip39UnlockConformanceTests {
    /// A salt for the cases that assert derivation is *refused*. Argon2id never
    /// runs for these: validation gates the seed, so the throw happens first.
    private static let unusedSalt = Data(repeating: 0, count: 16)

    @Test("phrase validation", arguments: VectorFiles.bip39Unlock.bip39)
    func phrase(_ testCase: Bip39UnlockVectors.PhraseCase) throws {
        // A phrase that is only valid after normalisation. `validateRecovery-
        // Phrase` returns the canonical form, so the five steps of §1.3 and
        // their idempotence are both assertable from here.
        if let canonical = testCase.canonicalised {
            #expect(try validateRecoveryPhrase(phrase: testCase.mnemonic) == canonical)
            #expect(try validateRecoveryPhrase(phrase: canonical) == canonical)
            return
        }

        switch (testCase.expectedValid, testCase.wordCount) {
        case (true, 12):
            // A 12-word phrase is valid BIP-39 and MUST still be refused:
            // accepting it silently halves the entropy.
            #expect(throws: RecoveryError.WrongWordCount(actual: 12)) {
                try validateRecoveryPhrase(phrase: testCase.mnemonic)
            }
            #expect(throws: RecoveryError.WrongWordCount(actual: 12)) {
                try deriveMasterKey(phrase: testCase.mnemonic, kdfSalt: Self.unusedSalt)
            }
        case (true, _):
            #expect(try validateRecoveryPhrase(phrase: testCase.mnemonic) == testCase.mnemonic)
        case (false, _):
            #expect(throws: RecoveryError.BadChecksum) {
                try validateRecoveryPhrase(phrase: testCase.mnemonic)
            }
            // Validation gates derivation: no master key may exist for this
            // input. `deriveMasterKey` is the only path to a seed the FFI
            // exports, so this is where that rule is checked from Swift.
            #expect(throws: RecoveryError.BadChecksum) {
                try deriveMasterKey(phrase: testCase.mnemonic, kdfSalt: Self.unusedSalt)
            }
        default:
            Issue.record("case has neither `canonicalised` nor `expectedValid`: \(testCase.name)")
        }
    }

    @Test("verifiers", arguments: VectorFiles.bip39Unlock.verifiers)
    func verifier(_ testCase: Bip39UnlockVectors.VerifierCase) throws {
        if let mnemonic = testCase.mnemonic, let saltHex = testCase.kdfSaltHex {
            try checkChain(testCase, mnemonic: mnemonic, saltHex: saltHex)
            return
        }
        if let masterKeyHex = testCase.masterKeyHex {
            try checkAccountVerifier(testCase, masterKeyHex: masterKeyHex)
            return
        }
        if let vaultKeyHex = testCase.vaultKeyHex, let vaultId = testCase.vaultId {
            #expect(
                try localVaultKeyVerifier(vaultKey: Data(hex: vaultKeyHex), vaultId: vaultId)
                    == testCase.expectedB64
            )
            return
        }
        if let publicKeyHex = testCase.ed25519PublicKeyHex {
            #expect(
                try localDeviceIdHex(ed25519PublicKey: Data(hex: publicKeyHex))
                    == testCase.expectedDeviceIdHex
            )
            return
        }
        Issue.record("unrecognised verifier case shape: \(testCase.name)")
    }

    /// phrase → master key → vault key → account key verifier.
    ///
    /// The seed itself is not exported, so `expectedSeedHex` is pinned
    /// transitively: a wrong seed cannot produce the committed master key.
    private func checkChain(
        _ testCase: Bip39UnlockVectors.VerifierCase,
        mnemonic: String,
        saltHex: String
    ) throws {
        let masterKey = try deriveMasterKey(phrase: mnemonic, kdfSalt: Data(hex: saltHex))
        if let expected = testCase.expectedMasterKeyHex {
            #expect(masterKey.hexString == expected)
        }
        if let expected = testCase.expectedVaultKeyHex {
            #expect(try deriveVaultKey(masterKey: masterKey).hexString == expected)
        }

        let verifier = try accountKeyVerifier(masterKey: masterKey)
        #expect(verifier == testCase.expectedAccountKeyVerifierB64)

        if let server = testCase.serverVerifierB64 {
            // FR-027's failure path: a valid phrase for the wrong account.
            #expect(
                accountKeyVerifierMatches(local: verifier, server: server)
                    == testCase.expectedMatch
            )
        }
    }

    private func checkAccountVerifier(
        _ testCase: Bip39UnlockVectors.VerifierCase,
        masterKeyHex: String
    ) throws {
        let verifier = try accountKeyVerifier(masterKey: Data(hex: masterKeyHex))
        #expect(verifier == testCase.expectedB64)

        // §1.4.1: the comparison is over the base64 STRINGS. Two spellings that
        // decode to the same bytes must NOT compare equal, which is the only
        // thing separating this from a decoded-bytes comparison.
        var unpadded = verifier
        while unpadded.hasSuffix("=") { unpadded.removeLast() }
        #expect(unpadded != verifier)
        #expect(!accountKeyVerifierMatches(local: verifier, server: unpadded))

        let padding = String(repeating: "=", count: (4 - unpadded.count % 4) % 4)
        let decodedUnpadded = Data(base64Encoded: unpadded + padding)
        #expect(decodedUnpadded != nil)
        #expect(
            decodedUnpadded == Data(base64Encoded: verifier),
            "the two spellings really do decode alike, so the assertion above is not vacuous"
        )
    }

    @Test("every case the file declares is exercised")
    func caseCount() {
        let file = VectorFiles.bip39Unlock
        #expect(file.bip39.count + file.verifiers.count == file.meta.caseCount)
    }
}

// MARK: - compression.json

@Suite("compression.json — chapter 04 §4.1")
struct CompressionConformanceTests {
    @Test("frames", arguments: VectorFiles.compression.cases)
    func frame(_ testCase: CompressionVectors.FrameCase) throws {
        let input = Data(hex: testCase.inputHex)
        #expect(input.count == testCase.inputBytes)

        let framed = compressPayload(payload: input)
        #expect(framed.hexString == testCase.expectedFrameHex)

        if let flag = testCase.expectedFlag {
            #expect(framed.first == UInt8(flag))
            // A zlib frame is RFC 1950, beginning `78 9c` at the default level.
            // The gzip magic `1f 8b 08` is a different format and produces a
            // client that cannot read any note body.
            if flag == 1 {
                #expect(Array(framed[1..<3]) == [0x78, 0x9c])
            }
        }

        #expect(try decompressPayload(frame: framed).hexString == testCase.expectedInflatedHex)
    }

    @Test("reader tolerance", arguments: VectorFiles.compression.readerCases)
    func readerFrame(_ testCase: CompressionVectors.ReaderCase) throws {
        // Any flag other than 0x01 is stored. There is no unknown-flag
        // rejection, so a reader that added one would refuse valid frames.
        #expect(
            try decompressPayload(frame: Data(hex: testCase.frameHex)).hexString
                == testCase.expectedInflatedHex
        )
    }

    @Test("rejected frames", arguments: VectorFiles.compression.errorCases)
    func rejectedFrame(_ testCase: CompressionVectors.ErrorCase) {
        let frame = Data(hex: testCase.frameHex)
        if testCase.name.contains("truncated") {
            // The one that must never degrade to an empty buffer: the applier
            // writes an empty body as a content wipe.
            #expect(throws: CompressError.IncompleteDeflateStream) {
                try decompressPayload(frame: frame)
            }
        } else {
            #expect(throws: CompressError.self) {
                try decompressPayload(frame: frame)
            }
        }
    }

    @Test("every case the file declares is exercised")
    func caseCount() {
        let file = VectorFiles.compression
        let total = file.cases.count + file.readerCases.count + file.errorCases.count
        #expect(total == file.meta.caseCount)
    }
}

// MARK: - crypto-vectors.json (the slice the exported surface reaches)

@Suite("crypto-vectors.json — the frozen primitives the FFI exports")
struct CryptoVectorsConformanceTests {
    @Test("KDF rows", arguments: VectorFiles.cryptoVectors.reachableKdfRows)
    func kdfRow(_ row: CryptoVectors.KdfRow) throws {
        let masterKey = Data(hex: row.masterKeyHex)
        switch row.contextName {
        case "memry-vault-key-v1":
            #expect(row.subkeyId == 1)
            #expect(try deriveVaultKey(masterKey: masterKey).hexString == row.derivedHex)
        case "memry-key-verifier-v1":
            #expect(row.subkeyId == 4)
            // The verifier is the base64 of exactly this subkey, §1.4.1.
            #expect(
                try accountKeyVerifier(masterKey: masterKey)
                    == Data(hex: row.derivedHex).base64EncodedString()
            )
        default:
            Issue.record("unreachable KDF context reached the suite: \(row.contextName)")
        }
    }

    /// Without this, renaming a context in the vector file would silently empty
    /// the parameterised test above and it would still report success.
    @Test("both reachable KDF contexts are present in the file")
    func reachableRowsArePresent() {
        #expect(
            VectorFiles.cryptoVectors.reachableKdfRows.count
                == CryptoVectors.reachableContextNames.count
        )
    }

    @Test("ed25519 public key to the locally derived device id")
    func deviceId() throws {
        let vector = VectorFiles.cryptoVectors.ed25519
        let derived = try localDeviceIdHex(ed25519PublicKey: Data(hex: vector.publicKeyHex))
        #expect(derived == vector.deviceIdHex)
        #expect(derived.count == 32)
        #expect(derived == derived.lowercased())
    }

    @Test("vaultUnlockFlow — the two stages the FFI exports")
    func vaultUnlockFlow() throws {
        // The Argon2id pass at the head of this flow takes a *password*, and
        // the exported `deriveMasterKey` takes a BIP-39 phrase, so the
        // password→masterKey stage has no entry point here and the committed
        // `masterKeyHex` is the input rather than an assertion. Everything
        // downstream of it is exported and is checked.
        let flow = VectorFiles.cryptoVectors.vaultUnlockFlow
        let masterKey = Data(hex: flow.masterKeyHex)
        #expect(try accountKeyVerifier(masterKey: masterKey) == flow.keyVerifierBase64)
        #expect(try deriveVaultKey(masterKey: masterKey).hexString == flow.vaultKeyHex)
    }
}

// MARK: - record-envelope.json (the compression stage)

@Suite("record-envelope.json — the compression stage inside the ciphertext")
struct RecordEnvelopeConformanceTests {
    /// The envelope's encrypt/sign stages need `sodium` primitives the FFI does
    /// not export. Stage one — the frame that sits inside the ciphertext — is
    /// exported, and it is the stage where a `pako`/zlib divergence shows up.
    @Test("compression stage", arguments: VectorFiles.recordEnvelope.cases)
    func compressionStage(_ testCase: RecordEnvelopeVectors.EnvelopeCase) throws {
        let content = Data(testCase.input.contentUtf8.utf8)
        let framed = compressPayload(payload: content)
        #expect(framed.hexString == testCase.expected.compressedHex)
        #expect(try decompressPayload(frame: framed) == content)
    }
}
