import type { CustomIconInputExtension } from '@memry/contracts/custom-icons-api'

import { commands, type CustomIconView } from '../../../generated/bindings'
import { invokeBinary } from '@/lib/ipc-binary'

/** The vault's custom icon library (`commands/custom_icons.rs`). */
export const customIconsService = {
  list: (): Promise<CustomIconView[]> => commands.customIconsList(),
  /** The file's bytes travel as the raw request body, not as base64. */
  add: (bytes: Uint8Array, name: string, ext: CustomIconInputExtension): Promise<CustomIconView> =>
    invokeBinary<CustomIconView>('custom_icons_add', bytes, { name, ext }),
  addFromUrl: (url: string): Promise<CustomIconView> => commands.customIconsAddFromUrl(url, null),
  rename: (id: string, name: string): Promise<CustomIconView> =>
    commands.customIconsRename(id, name),
  delete: (id: string): Promise<boolean> => commands.customIconsDelete(id)
}
