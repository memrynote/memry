export interface KeepLabel {
  name: string
}

export interface KeepAttachment {
  filePath: string
  mimetype: string
}

export interface KeepListItem {
  text: string
  isChecked: boolean
}

export interface KeepNote {
  title: string
  textContent: string
  listContent?: KeepListItem[]
  color: string
  labels: KeepLabel[]
  isPinned: boolean
  isArchived: boolean
  isTrashed: boolean
  attachments: KeepAttachment[]
  createdTimestampUsec: number
  userEditedTimestampUsec: number
}

export interface MappedNote {
  title: string
  body: string
  tags: string[]
  created: string
  modified: string
  attachmentPaths: string[]
}
