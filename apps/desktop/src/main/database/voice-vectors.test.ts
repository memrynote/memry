import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deleteVoiceVectors,
  nearestVoiceItems,
  readVoiceVectorStates,
  replaceVoiceVectors
} from './voice-vectors'
import { EMBEDDING_DIMENSION } from '../lib/embeddings-constants'

function unit(axis: number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIMENSION)
  v[axis] = 1
  return v
}

describe('voice vectors', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    sqliteVec.load(db)
  })
  afterEach(() => db.close())

  it('returns one hit per memo, its best window, with how it was embedded', () => {
    replaceVoiceVectors(db, 'memo-a', 'audio', 1, [unit(0), unit(1)])
    replaceVoiceVectors(db, 'memo-b', 'transcript', 4, [unit(2)])

    const hits = nearestVoiceItems(db, unit(1), 10)
    expect(hits[0]).toMatchObject({ id: 'memo-a', source: 'audio' })
    expect(hits[0].cosine).toBeCloseTo(1)
    expect(hits.filter((hit) => hit.id === 'memo-a')).toHaveLength(1)
    expect(hits.find((hit) => hit.id === 'memo-b')?.source).toBe('transcript')
  })

  it('replacing and deleting a memo leaves no stale windows behind', () => {
    replaceVoiceVectors(db, 'memo-a', 'audio', 1, [unit(0), unit(1), unit(2)])
    replaceVoiceVectors(db, 'memo-a', 'transcript', 4, [unit(3)])
    expect(db.prepare('SELECT count(*) AS n FROM vec_voice').get()).toEqual({ n: 1 })
    expect(readVoiceVectorStates(db).get('memo-a')).toEqual({
      source: 'transcript',
      inputVersion: 4,
      chunks: 1
    })

    deleteVoiceVectors(db, 'memo-a')
    expect(db.prepare('SELECT count(*) AS n FROM vec_voice').get()).toEqual({ n: 0 })
    expect(readVoiceVectorStates(db).size).toBe(0)
  })
})
