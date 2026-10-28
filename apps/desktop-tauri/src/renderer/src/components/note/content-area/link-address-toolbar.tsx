import {
  DEFAULT_LINK_PROTOCOL,
  LinkToolbarExtension,
  VALID_LINK_PROTOCOLS
} from '@blocknote/core/extensions'
import {
  DeleteLinkButton,
  LinkToolbar,
  LinkToolbarController,
  useComponentsContext,
  useDictionary,
  useExtension,
  type LinkToolbarProps
} from '@blocknote/react'
import { linkDestination, withLinkDestination } from '@memry/editor-schema/inline'
import { useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { Link, Type } from 'lucide-react'
import { ExternalLink } from '@/lib/icons'
import { openLink } from '@/lib/external-link-guard'

/**
 * BlockNote's link toolbar, reading the address half of a link's `href`.
 *
 * Since BBF-109 a spaced destination keeps its title and angle brackets in
 * `href` (`[a](u "T")` has `href` `u "T"`). The stock toolbar opened and edited
 * that whole string; this one opens the address and edits only the address,
 * so the title survives (BBF-112).
 */
export function LinkAddressToolbar(props: LinkToolbarProps): React.JSX.Element {
  return (
    <LinkToolbar {...props}>
      <EditLinkAddressButton {...props} />
      <OpenLinkAddressButton url={linkDestination(props.url)} />
      <DeleteLinkButton range={props.range} setToolbarOpen={props.setToolbarOpen} />
    </LinkToolbar>
  )
}

/**
 * BlockNote's `links.onClick`: opens the address half of the clicked link.
 * BlockNote's default opened the whole `href`, title included (BBF-112).
 */
export function openLinkAddress(event: MouseEvent): boolean {
  const href =
    event.target instanceof Element ? event.target.closest('a')?.getAttribute('href') : undefined
  if (href) openLink(linkDestination(href))
  return true
}

/** Mount inside `<BlockNoteView linkToolbar={false}>`. */
export function LinkAddressToolbarController(): React.JSX.Element {
  return <LinkToolbarController linkToolbar={LinkAddressToolbar} />
}

/** BlockNote's `OpenLinkButton` calls `window.open`, which opens nothing on macOS (#3675). */
function OpenLinkAddressButton({ url }: { url: string }): React.JSX.Element {
  const Components = useComponentsContext()!
  const dict = useDictionary()
  return (
    <Components.LinkToolbar.Button
      className="bn-button"
      mainTooltip={dict.link_toolbar.open.tooltip}
      label={dict.link_toolbar.open.tooltip}
      isSelected={false}
      onClick={() => openLink(url)}
      icon={<ExternalLink className="size-4" />}
    />
  )
}

function EditLinkAddressButton(props: LinkToolbarProps): React.JSX.Element {
  const Components = useComponentsContext()!
  const dict = useDictionary()
  return (
    <Components.Generic.Popover.Root onOpenChange={props.setToolbarPositionFrozen}>
      <Components.Generic.Popover.Trigger>
        <Components.LinkToolbar.Button
          className="bn-button"
          mainTooltip={dict.link_toolbar.edit.tooltip}
          isSelected={false}
        >
          {dict.link_toolbar.edit.text}
        </Components.LinkToolbar.Button>
      </Components.Generic.Popover.Trigger>
      <Components.Generic.Popover.Content
        className="bn-popover-content bn-form-popover"
        variant="form-popover"
      >
        <EditLinkAddressForm {...props} />
      </Components.Generic.Popover.Content>
    </Components.Generic.Popover.Root>
  )
}

// BlockNote's `validateUrl` (EditLinkMenuItems.tsx).
const withProtocol = (url: string): string =>
  VALID_LINK_PROTOCOLS.some((protocol) => url.startsWith(protocol))
    ? url
    : `${DEFAULT_LINK_PROTOCOL}://${url}`

function EditLinkAddressForm(props: LinkToolbarProps): React.JSX.Element {
  const Components = useComponentsContext()!
  const dict = useDictionary()
  const { editLink } = useExtension(LinkToolbarExtension)
  const address = linkDestination(props.url)
  const [url, setUrl] = useState(address)
  const [text, setText] = useState(props.text)

  const submit = (): void => {
    const href = url === address ? props.url : withLinkDestination(props.url, withProtocol(url))
    editLink(href, text, props.range.from)
    props.setToolbarOpen?.(false)
    props.setToolbarPositionFrozen?.(false)
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    event.preventDefault()
    submit()
  }

  return (
    <Components.Generic.Form.Root>
      <Components.Generic.Form.TextInput
        className="bn-text-input"
        name="url"
        icon={<Link className="size-4" />}
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- input opens inside a popover/dialog the user just invoked, so focus must land here
        autoFocus={true}
        placeholder={dict.link_toolbar.form.url_placeholder}
        value={url}
        onKeyDown={onKeyDown}
        onChange={(event: ChangeEvent<HTMLInputElement>) => setUrl(event.currentTarget.value)}
        onSubmit={submit}
      />
      <Components.Generic.Form.TextInput
        className="bn-text-input"
        name="title"
        icon={<Type className="size-4" />}
        placeholder={dict.link_toolbar.form.title_placeholder}
        value={text}
        onKeyDown={onKeyDown}
        onChange={(event: ChangeEvent<HTMLInputElement>) => setText(event.currentTarget.value)}
        onSubmit={submit}
      />
    </Components.Generic.Form.Root>
  )
}
