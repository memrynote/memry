import type {
  NoteClustersResponse,
  NoteTagSuggestionsResponse,
  SimilarNotesResponse
} from '@memry/contracts/notes-api'
import { commands } from '../../../generated/bindings'

/**
 * Similar notes, tag suggestions and canvas groups from the local embeddings, over the
 * `notes_get_similar`, `notes_get_tag_suggestions` and `notes_cluster` commands (#3540). The
 * bindings type each `f64` as nullable (a NaN crosses as null) and the grouping's status as all
 * three; each answer is narrowed to its contract type here.
 */
export const similarityService = {
  async getSimilar(noteId: string, limit?: number): Promise<SimilarNotesResponse> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- similarities are calibrated cosines, never NaN
    return (await commands.notesGetSimilar(noteId, limit ?? null)) as SimilarNotesResponse
  },

  async getTagSuggestions(noteId: string): Promise<NoteTagSuggestionsResponse> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- confidences are finite blends of similarities
    return (await commands.notesGetTagSuggestions(noteId)) as NoteTagSuggestionsResponse
  },

  async cluster(noteIds: string[]): Promise<NoteClustersResponse> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the command answers `disabled` or `ready` only (`domain::similarity::group_notes`)
    return (await commands.notesCluster(noteIds)) as NoteClustersResponse
  }
}
