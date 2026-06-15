export interface BearInfo {
  uniqueIdentifier?: string
  created?: Date
  modified?: Date
  archived: boolean
  trashed: boolean
}

export interface MappedNote {
  title: string
  body: string
  tags: string[]
  archived: boolean
  trashed: boolean
  folder: 'Bear' | 'Bear/Archived' | 'Bear/Trash'
  created?: Date
  modified?: Date
  assetRefs: string[] // list of asset filenames referenced in body
}
