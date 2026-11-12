/**
 * Stands in for a capture's file while its bytes are not on this device: the
 * item synced before its file did, or the file was never uploaded (storage
 * quota, plan file cap). Replaces the grey placeholder icon for image, voice,
 * video and PDF previews.
 */

import { useT } from '@memry/i18n/renderer'
import { HardDrive } from '@/lib/icons'
import type { InboxItem, InboxItemListItem } from '@/types'

/** True for a full item whose file is not on disk; a list row carries no attachment URL to judge by. */
export const isFileOnOtherDevice = (item: InboxItem | InboxItemListItem): boolean =>
  'attachmentUrl' in item && !item.attachmentUrl

export const FileOnOtherDevice = (): React.JSX.Element => {
  const { t } = useT('inbox')

  return (
    <output className="flex items-center gap-3 rounded-lg bg-muted px-3.5 py-3 text-sm text-text-secondary">
      <HardDrive className="size-4 shrink-0" aria-hidden="true" />
      <span>{t('content.fileOnOtherDevice')}</span>
    </output>
  )
}
