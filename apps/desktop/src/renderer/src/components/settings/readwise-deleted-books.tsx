import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import type { ReadwiseDeletedBook } from '@memry/contracts/import-channels'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { SETTINGS_GROUP_LABEL } from '@/components/settings/settings-primitives'
import { getActiveLocale } from '@/lib/active-locale'
import { extractErrorMessage, unwrapIpcResult as unwrap } from '@/lib/ipc-error'

const keyOf = (book: ReadwiseDeletedBook): string =>
  String(book.readwiseBookId ?? book.readerDocumentId)

interface ReadwiseDeletedBooksProps {
  /** False on a device another device pulls for: the list lives on the pulling device (D8, D16). */
  pullsHere: boolean
  pullingDeviceName: string | null
  disabled: boolean
}

function deletedOn(iso: string): string {
  return new Intl.DateTimeFormat(getActiveLocale(), { day: 'numeric', month: 'short' }).format(
    new Date(iso)
  )
}

/**
 * The Deleted books list of the Readwise panel (#1408 D16): books whose note the
 * user deleted, each with Restore. Restore recreates the note with every
 * highlight, then the row leaves the list.
 */
export function ReadwiseDeletedBooks({
  pullsHere,
  pullingDeviceName,
  disabled
}: ReadwiseDeletedBooksProps) {
  const { t } = useT('settings')
  const [books, setBooks] = useState<ReadwiseDeletedBook[] | null>(null)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (!pullsHere) return
    void window.api.import.readwise
      .listDeleted()
      .then((raw) => {
        if (mounted.current)
          setBooks(unwrap(raw, t('import.dialog.readwise.deleted.loadFailed')).books)
      })
      .catch((err) => {
        if (mounted.current) {
          setBooks([])
          setError(extractErrorMessage(err, t('import.dialog.readwise.deleted.loadFailed')))
        }
      })
  }, [pullsHere, t])

  const restore = useCallback(
    async (book: ReadwiseDeletedBook) => {
      setRestoring(keyOf(book))
      setError(null)
      try {
        unwrap(
          await window.api.import.readwise.restoreBook(
            book.readwiseBookId !== null
              ? { readwiseBookId: book.readwiseBookId }
              : { readerDocumentId: book.readerDocumentId as string }
          ),
          t('import.dialog.readwise.deleted.restoreFailed')
        )
        if (mounted.current) {
          setBooks((list) => list?.filter((row) => keyOf(row) !== keyOf(book)) ?? [])
        }
      } catch (err) {
        if (mounted.current) {
          setError(extractErrorMessage(err, t('import.dialog.readwise.deleted.restoreFailed')))
        }
      } finally {
        if (mounted.current) setRestoring(null)
      }
    },
    [t]
  )

  return (
    <section className="flex flex-col" aria-labelledby="readwise-deleted-heading">
      <h4 id="readwise-deleted-heading" className={SETTINGS_GROUP_LABEL}>
        {t('import.dialog.readwise.deleted.heading')}
      </h4>
      <p className="pb-1.5 text-xs/4 text-muted-foreground">
        {t('import.dialog.readwise.deleted.description')}
      </p>
      {!pullsHere ? (
        <p className="py-3 text-xs/4 text-muted-foreground">
          {pullingDeviceName
            ? t('import.dialog.readwise.deleted.syncsOn', { device: pullingDeviceName })
            : t('import.dialog.readwise.deleted.syncsOnAnotherDevice')}
        </p>
      ) : books === null ? (
        <div className="flex justify-center py-7">
          <Spinner />
        </div>
      ) : books.length === 0 ? (
        <p className="py-7 text-center text-[13px]/5 text-muted-foreground">
          {t('import.dialog.readwise.deleted.empty')}
        </p>
      ) : (
        <>
          <ul>
            {books.map((book) => (
              <li
                key={keyOf(book)}
                className="flex min-h-13 items-center gap-4 border-b border-border py-2.5"
              >
                <div className="flex min-w-0 grow flex-col gap-0.5">
                  <span className="truncate text-[13px]/5 font-medium text-foreground">
                    {book.title}
                  </span>
                  <span className="text-xs/4 text-muted-foreground">
                    {book.readwiseBookId === null
                      ? t('import.dialog.readwise.deleted.metaDocument', {
                          date: deletedOn(book.deletedAt)
                        })
                      : t('import.dialog.readwise.deleted.meta', {
                          date: deletedOn(book.deletedAt),
                          count: book.highlightCount
                        })}
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void restore(book)}
                  disabled={disabled || restoring !== null}
                >
                  {t('import.dialog.readwise.deleted.restore')}
                </Button>
              </li>
            ))}
          </ul>
          <p className="pt-2.5 text-xs/4 text-muted-foreground">
            {t('import.dialog.readwise.deleted.footer')}
          </p>
        </>
      )}
      {error && (
        <p role="alert" className="pt-2 text-xs/4 text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
