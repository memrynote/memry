/**
 * Registry of the composite vector classes: each class's files and the builder
 * behind each file.
 *
 * Extracted from gen-protocol-vectors.ts so the runner and the registry stay
 * under the 300-line ceiling that scripts/check-line-ceilings.mjs enforces. A
 * new class is one import and one entry here.
 */
import { buildAgentEnvelope } from './vectors/agent-envelope'
import { buildBip39Unlock } from './vectors/bip39-unlock'
import { buildCborCanonical } from './vectors/cbor-canonical'
import { buildCompression } from './vectors/compression'
import { buildCrdtCompact } from './vectors/crdt-compact'
import { buildCrdtUpdate } from './vectors/crdt-update'
import { buildDeviceLinking } from './vectors/device-linking'
import { buildFieldMerge } from './vectors/field-merge'
import { buildJournal } from './vectors/journal'
import { buildMarkdownRoundtrip } from './vectors/markdown-roundtrip'
import { buildMarkdownSeed } from './vectors/markdown-seed'
import { buildAttachmentManifest } from './vectors/attachment-manifest'
import { buildChunkHolds } from './vectors/chunk-holds'
import { buildBlockEdit } from './vectors/block-edit'
import { buildCalendar } from './vectors/calendar'
import { buildCalendarIcal } from './vectors/calendar-ical'
import { buildCalendarWrite } from './vectors/calendar-write'
import { buildEmbeddingInput } from './vectors/embedding-input'
import { buildInbox } from './vectors/inbox'
import { buildDeleteAttestation } from './vectors/delete-attestation'
import { buildDeleteKeep } from './vectors/delete-keep'
import { buildNoteBlocks } from './vectors/note-blocks'
import { buildPackContainer } from './vectors/pack-container'
import { buildPortalResolve } from './vectors/portal-resolve'
import { buildPayloadSchemas } from './vectors/payload-schemas'
import { buildRecordEnvelope } from './vectors/record-envelope'
import { buildRecreateClock } from './vectors/recreate-clock'
import { buildRedact, buildSafeDimension } from './vectors/redact'
import { buildTelemetryEvents } from './vectors/telemetry-events'
import { buildSettingsGroups } from './vectors/settings-groups'
import { buildSettingsMerge } from './vectors/settings-merge'
import { buildTagFold } from './vectors/tag-fold'
import { buildTagSchemaRefs } from './vectors/tag-schema-refs'
import { buildTaskCompletionSpawn } from './vectors/task-completion-spawn'
import { buildTaskFiltering } from './vectors/task-filtering'
import { buildTaskParsing } from './vectors/task-parsing'
import { buildTextExtract } from './vectors/text-extract'
import { buildVersionedValues } from './vectors/versioned-values'
import { buildUnlinkedMentions } from './vectors/unlinked-mentions'
import { buildVaultName } from './vectors/vault-name'
import { buildWikiTargetResolution } from './vectors/wiki-target-resolution'
import { committedVector } from './vectors/shared'

/** One class: its file, and the builder that produces its contents. */
export interface VectorClass {
  readonly name: string
  /** Relative to `test-vectors/`. A class may own more than one file. */
  readonly files: ReadonlyArray<{
    readonly path: string
    readonly build: () => unknown
  }>
}

export const CLASSES: readonly VectorClass[] = [
  { name: 'bip39-unlock', files: [{ path: 'bip39-unlock.json', build: buildBip39Unlock }] },
  {
    name: 'record-envelope',
    files: [{ path: 'record-envelope.json', build: buildRecordEnvelope }]
  },
  { name: 'agent-envelope', files: [{ path: 'agent-envelope.json', build: buildAgentEnvelope }] },
  { name: 'vault-name', files: [{ path: 'vault-name.json', build: buildVaultName }] },
  { name: 'crdt-update', files: [{ path: 'crdt-update.json', build: buildCrdtUpdate }] },
  { name: 'crdt-compact', files: [{ path: 'crdt-compact.json', build: buildCrdtCompact }] },
  { name: 'cbor-canonical', files: [{ path: 'cbor-canonical.json', build: buildCborCanonical }] },
  { name: 'compression', files: [{ path: 'compression.json', build: buildCompression }] },
  { name: 'field-merge', files: [{ path: 'field-merge.json', build: buildFieldMerge }] },
  {
    name: 'redact',
    files: [
      { path: 'redact.json', build: buildRedact },
      { path: 'safe-dimension.json', build: buildSafeDimension }
    ]
  },
  {
    name: 'telemetry-events',
    files: [{ path: 'telemetry-events.json', build: buildTelemetryEvents }]
  },
  {
    name: 'settings-groups',
    files: [{ path: 'settings-groups.json', build: buildSettingsGroups }]
  },
  { name: 'settings-merge', files: [{ path: 'settings-merge.json', build: buildSettingsMerge }] },
  { name: 'recreate-clock', files: [{ path: 'recreate-clock.json', build: buildRecreateClock }] },
  {
    name: 'versioned-values',
    files: [{ path: 'versioned-values.json', build: buildVersionedValues }]
  },
  { name: 'tag-fold', files: [{ path: 'tag-fold.json', build: buildTagFold }] },
  {
    name: 'wiki-target-resolution',
    files: [{ path: 'wiki-target-resolution.json', build: buildWikiTargetResolution }]
  },
  {
    name: 'unlinked-mentions',
    files: [{ path: 'unlinked-mentions.json', build: buildUnlinkedMentions }]
  },
  {
    name: 'tag-schema-refs',
    files: [{ path: 'tag-schema-refs.json', build: buildTagSchemaRefs }]
  },
  { name: 'delete-keep', files: [{ path: 'delete-keep.json', build: buildDeleteKeep }] },
  { name: 'pack-container', files: [{ path: 'pack-container.json', build: buildPackContainer }] },
  {
    name: 'payload-schemas',
    files: [{ path: 'payload-schemas.json', build: buildPayloadSchemas }]
  },
  { name: 'device-linking', files: [{ path: 'device-linking.json', build: buildDeviceLinking }] },
  { name: 'text-extract', files: [{ path: 'text-extract.json', build: buildTextExtract }] },
  { name: 'note-blocks', files: [{ path: 'note-blocks.json', build: buildNoteBlocks }] },
  { name: 'block-edit', files: [{ path: 'block-edit.json', build: buildBlockEdit }] },
  { name: 'task-parsing', files: [{ path: 'task-parsing.json', build: buildTaskParsing }] },
  {
    name: 'task-filtering',
    files: [{ path: 'task-filtering.json', build: buildTaskFiltering }]
  },
  {
    name: 'task-completion-spawn',
    files: [{ path: 'task-completion-spawn.json', build: buildTaskCompletionSpawn }]
  },
  { name: 'journal', files: [{ path: 'journal.json', build: buildJournal }] },
  { name: 'markdown-seed', files: [{ path: 'markdown-seed.json', build: buildMarkdownSeed }] },
  { name: 'inbox', files: [{ path: 'inbox.json', build: buildInbox }] },
  { name: 'calendar', files: [{ path: 'calendar.json', build: buildCalendar }] },
  {
    name: 'calendar-ical',
    files: [{ path: 'calendar-ical.json', build: buildCalendarIcal }]
  },
  {
    name: 'calendar-write',
    files: [{ path: 'calendar-write.json', build: buildCalendarWrite }]
  },
  {
    name: 'embedding-input',
    files: [{ path: 'embedding-input.json', build: buildEmbeddingInput }]
  },
  {
    name: 'attachment-manifest',
    files: [{ path: 'attachment-manifest.json', build: buildAttachmentManifest }]
  },
  { name: 'chunk-holds', files: [{ path: 'chunk-holds.json', build: buildChunkHolds }] },
  {
    name: 'delete-attestation',
    files: [{ path: 'delete-attestation.json', build: buildDeleteAttestation }]
  },
  { name: 'portal-resolve', files: [{ path: 'portal-resolve.json', build: buildPortalResolve }] },
  {
    // Digest-only: generated by `pnpm --filter @memry/desktop vectors:note-fold`, which runs
    // the Electron fold engine as the oracle (a package never imports an app).
    name: 'note-fold',
    files: ['note-fold-text.json', 'note-fold.json'].map((path) => ({
      path,
      build: () => committedVector(path)
    }))
  },
  {
    // Digest-only: generated by `pnpm --filter @memry/desktop vectors:markdown-convert`,
    // which runs the Electron converter as the oracle (a package never imports an app).
    name: 'markdown-convert',
    files: [
      'frontmatter.json',
      'markdown-class.json',
      'note-stats.json',
      'pm-schema.json',
      'yxml.json',
      'md-to-html.json',
      'html-to-blocks.json',
      'parse.json',
      'memry-parse.json',
      'serialize.json',
      'layer-text.json',
      'layer-markers.json',
      'layer-blocks.json',
      'layer-critic.json',
      'seed-corpus.json',
      'grammar-corpus.json',
      'seed-doc.json',
      'roundtrip.json',
      'blocks.json',
      'serialize-doc.json',
      'replace-body.json'
    ].map((name) => ({
      path: `markdown-convert/${name}`,
      build: () => committedVector(`markdown-convert/${name}`)
    }))
  },
  {
    name: 'markdown-roundtrip',
    files: [
      { path: 'markdown-roundtrip/cases.json', build: () => buildMarkdownRoundtrip().cases },
      {
        path: 'markdown-roundtrip/fuzz-families.json',
        build: () => buildMarkdownRoundtrip().fuzzFamilies
      }
    ]
  }
]
