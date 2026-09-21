/**
 * One lazily-built protobuf root for the Apple Notes descriptor.
 *
 * Note bodies and table payloads share the descriptor (a table cell is a `Note`
 * message), and an import decodes thousands of them — building the root once
 * keeps that off the per-note path.
 */

import { Root, type Type } from 'protobufjs'
import { descriptor } from './descriptor.ts'

let cachedRoot: Root | null = null

export function lookupAppleNotesType(fullyQualifiedName: string): Type {
  if (!cachedRoot) cachedRoot = Root.fromJSON(descriptor)
  return cachedRoot.lookupType(fullyQualifiedName)
}
