/** Types and the field-type list for `tag-schema.ts`. */
import type { ResolvedTag } from '@memry/contracts/tag-schema'
import type { ImpactQuery, ImpactResult, NewFieldSpec } from '@memry/contracts/tag-schema-api'
import type {
  GetLinkedHereInput,
  LinkedHereGroup,
  SearchObjectsResponse
} from '@memry/contracts/tag-objects-api'

export type NewFieldType = NewFieldSpec['type']

// `NEW_FIELD_TYPES` in contracts/tag-schema-api.ts. That module imports its
// siblings without an extension, which Node's type stripping cannot resolve, so
// the CLI keeps the list here; the `satisfies` and the check below fail the
// typecheck when desktop adds a type.
export const NEW_FIELD_TYPES = [
  'text',
  'number',
  'checkbox',
  'date',
  'url',
  'status',
  'select',
  'multiselect',
  'relation'
] as const satisfies readonly NewFieldType[]
const _allFieldTypesListed: Exclude<NewFieldType, (typeof NEW_FIELD_TYPES)[number]> extends never
  ? true
  : never = true
void _allFieldTypesListed

export interface TagFieldInput {
  name: string
  type: NewFieldType
  options?: string[]
  relation?: { target: string; many: boolean; inverse: string | null }
}

export type TagSchemaEdit =
  | { kind: 'add-field'; tag: string; field: TagFieldInput; index?: number }
  | { kind: 'remove-field'; tag: string; name: string }
  | { kind: 'move-field'; tag: string; name: string; toIndex: number }
  | {
      kind: 'set-relation'
      tag: string
      name: string
      relation: { target: string; many: boolean; inverse: string | null }
    }
  | { kind: 'set-template'; tag: string; template: { id: string; autofill: boolean } | null }
  | { kind: 'set-extends'; tag: string; parent: string | null }

export interface TagSchemaEditResult {
  tag: string
  changed: boolean
  schema: ResolvedTag | null
}

export interface TagCategoryRecord {
  id: string
  name: string
  sortOrder: number
  tagCount: number
}

export interface TagSchemaOverview {
  tags: Record<string, ResolvedTag>
  /** Note id to the key of its primary object tag. */
  objects: Record<string, string>
}

export interface TagSchemaService {
  snapshot(): Promise<TagSchemaOverview>
  schemaOf(tag: string): Promise<ResolvedTag>
  edit(edit: TagSchemaEdit): Promise<TagSchemaEditResult>
  impact(query: ImpactQuery): Promise<ImpactResult>
  objects(input: { query: string; tag?: string; limit: number }): Promise<SearchObjectsResponse>
  linkedHere(input: GetLinkedHereInput): Promise<LinkedHereGroup[]>
  setIcon(tag: string, icon: string | null): Promise<{ tag: string; icon: string | null }>
  pin(tag: string, noteId: string): Promise<{ success: true }>
  unpin(tag: string, noteId: string): Promise<{ success: true }>
  reorder(input: {
    tags: string[]
    /** A category id, or null for no category. Omitted: each tag keeps its own. */
    category?: string | null
  }): Promise<{
    success: true
    tags: Array<{ tag: string; categoryId: string | null; sortOrder: number }>
  }>
  categories: {
    list(): Promise<TagCategoryRecord[]>
    create(name: string): Promise<TagCategoryRecord>
    rename(id: string, name: string): Promise<{ success: true }>
    delete(id: string): Promise<{ success: true }>
    reorder(ids: string[]): Promise<{ success: true }>
  }
}
