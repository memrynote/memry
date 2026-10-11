import {
  DEFAULT_LINK_PROTOCOL,
  LinkToolbarExtension,
  VALID_LINK_PROTOCOLS
} from '@blocknote/core/extensions'
import {
  DeleteLinkButton,
  LinkToolbar,
  LinkToolbarController,
  OpenLinkButton,
  useComponentsContext,
  useDictionary,
  useExtension,
  type LinkToolbarProps
} from '@blocknote/react'
import { linkDestination, withLinkDestination } from '@memry/editor-schema/inline'
import { useState, type FormEvent, type KeyboardEvent } from 'react'
import { Link, Type } from 'lucide-react'

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
      <OpenLinkButton url={linkDestination(props.url)} />
      <DeleteLinkButton range={props.range} setToolbarOpen={props.setToolbarOpen} />
    </LinkToolbar>
  )
}

/** Mount inside `<BlockNoteView linkToolbar={false}>`. */
export function LinkAddressToolbarController(): React.JSX.Element {
  return <LinkToolbarController linkToolbar={LinkAddressToolbar} />
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
        autoFocus={true}
        placeholder={dict.link_toolbar.form.url_placeholder}
        value={url}
        onKeyDown={onKeyDown}
        onChange={(event: FormEvent<HTMLInputElement>) => setUrl(event.currentTarget.value)}
        onSubmit={submit}
      />
      <Components.Generic.Form.TextInput
        className="bn-text-input"
        name="title"
        icon={<Type className="size-4" />}
        placeholder={dict.link_toolbar.form.title_placeholder}
        value={text}
        onKeyDown={onKeyDown}
        onChange={(event: FormEvent<HTMLInputElement>) => setText(event.currentTarget.value)}
        onSubmit={submit}
      />
    </Components.Generic.Form.Root>
  )
}
