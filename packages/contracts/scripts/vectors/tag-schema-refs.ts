/**
 * Case input: `schema`, `from`, `to` (null on delete) → `expected.schema`, the
 * rewritten schema, or null when nothing names `from` (§13.7.7.2).
 */
import { rewriteSchemaReference } from '../../src/tag-schema.ts'
import { meta } from './shared'

interface CaseSpec {
  name: string
  pins: string
  input: { schema: Record<string, unknown>; from: string; to: string | null }
}

const SPECS: CaseSpec[] = [
  {
    name: 'rename-extends',
    pins: 'extends naming from points at to; t + 1',
    input: { schema: { t: 2, extends: 'job', fields: [], preset: null }, from: 'job', to: 'career' }
  },
  {
    name: 'rename-relation-targets-mixed-case',
    pins: 'every matching target is rewritten, compared trimmed and lowercased; to is lowercased',
    input: {
      schema: {
        t: 3,
        extends: null,
        fields: [
          { name: 'Company', relation: { target: 'Company', many: false, inverse: 'People' } },
          { name: 'Role' },
          { name: 'Employer', relation: { target: ' COMPANY ', many: true } },
          { name: 'Friend', relation: { target: 'person' } }
        ]
      },
      from: 'company',
      to: ' Org '
    }
  },
  {
    name: 'delete-to-null',
    pins: 'to null clears extends and targets to null',
    input: {
      schema: { t: 1, extends: 'job', fields: [{ name: 'A', relation: { target: 'job' } }] },
      from: 'Job',
      to: null
    }
  },
  {
    name: 'no-match',
    pins: 'nothing names from: null, the schema is unchanged',
    input: {
      schema: { t: 4, extends: 'work', fields: [{ name: 'A', relation: { target: null } }] },
      from: 'job',
      to: 'career'
    }
  },
  {
    name: 'unknown-keys-preserved',
    pins: 'every other key at every depth is kept',
    input: {
      schema: {
        t: 1,
        extends: 'job',
        future: { nested: [1, 2] },
        template: { id: 'tpl_1', autofill: true },
        fields: [{ name: 'A', extra: 'x', relation: { target: 'job', inverse: 'Bs', later: true } }]
      },
      from: 'job',
      to: 'career'
    }
  },
  {
    name: 't-missing',
    pins: 'a missing t reads as 0',
    input: { schema: { extends: 'job' }, from: 'job', to: 'career' }
  },
  {
    name: 't-invalid',
    pins: 'a negative, fractional or non-number t reads as 0',
    input: {
      schema: { t: -3, extends: 'job', fields: [{ relation: { target: 'job' } }] },
      from: 'job',
      to: 'career'
    }
  },
  {
    name: 't-string',
    pins: 'a string t reads as 0',
    input: { schema: { t: '7', extends: 'job' }, from: 'job', to: 'career' }
  },
  {
    name: 'from-equals-to',
    pins: 'to equal to from after folding is a no-op',
    input: { schema: { t: 2, extends: 'job' }, from: 'job', to: ' JOB ' }
  },
  {
    name: 'non-object-fields-left-alone',
    pins: 'fields entries that are not objects, or whose relation is not an object, are untouched',
    input: {
      schema: {
        t: 5,
        fields: [
          'job',
          null,
          3,
          [{ relation: { target: 'job' } }],
          { name: 'R', relation: 'job' },
          { name: 'S', relation: { target: 'job' } }
        ]
      },
      from: 'job',
      to: 'career'
    }
  },
  {
    name: 'fields-not-array',
    pins: 'a non-array fields is kept as is',
    input: {
      schema: { t: 1, extends: 'job', fields: { target: 'job' } },
      from: 'job',
      to: 'career'
    }
  }
]

export function buildTagSchemaRefs(): Record<string, unknown> {
  const cases = SPECS.map((spec) => ({
    ...spec,
    expected: { schema: rewriteSchemaReference(spec.input.schema, spec.input.from, spec.input.to) }
  }))
  return {
    meta: meta({
      class: 'tag-schema-refs',
      chapter: 'docs/protocol/13-payload-schemas.md',
      source: 'packages/contracts/src/tag-schema.ts',
      caseCount: cases.length
    }),
    cases
  }
}
