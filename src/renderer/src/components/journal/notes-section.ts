export interface Note {
  id: string
  title: string
  content?: string
  preview?: string
  path?: string
  tags?: string[]
  createdAt?: string
  modifiedAt?: string
}
