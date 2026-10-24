export type RpcMode = 'invoke' | 'sync'

/** Any function shape: `never` params accept every signature, `unknown` every result. */
export type AnyRpcFn = (...args: never[]) => unknown

export interface RpcMethodSpec<Fn extends AnyRpcFn> {
  channel: string
  params: readonly string[]
  invokeArgs: readonly string[]
  mode: RpcMode
  implementation?: string
  __fn?: Fn
}

export interface RpcEventSpec<Fn extends AnyRpcFn> {
  channel: string
  __fn?: Fn
}

export interface RpcDomainSpec<
  Name extends string,
  Methods extends Record<string, RpcMethodSpec<AnyRpcFn>>,
  Events extends Record<string, RpcEventSpec<AnyRpcFn>>
> {
  name: Name
  methods: Methods
  events: Events
}

export function defineMethod<Fn extends AnyRpcFn>(config: {
  channel: string
  params?: readonly string[]
  invokeArgs?: readonly string[]
  mode?: RpcMode
  implementation?: string
}): RpcMethodSpec<Fn> {
  return {
    channel: config.channel,
    params: config.params ?? [],
    invokeArgs: config.invokeArgs ?? config.params ?? [],
    mode: config.mode ?? 'invoke',
    implementation: config.implementation
  }
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Payload is the subscriber's assertion about an untyped IPC event payload
export function defineEvent<Payload>(
  channel: string
): RpcEventSpec<(callback: (payload: Payload) => void) => () => void> {
  return { channel }
}

export function defineDomain<
  Name extends string,
  Methods extends Record<string, RpcMethodSpec<AnyRpcFn>>,
  Events extends Record<string, RpcEventSpec<AnyRpcFn>>
>(domain: RpcDomainSpec<Name, Methods, Events>): RpcDomainSpec<Name, Methods, Events> {
  return domain
}

export type RpcClient<
  TDomain extends RpcDomainSpec<
    string,
    Record<string, RpcMethodSpec<AnyRpcFn>>,
    Record<string, RpcEventSpec<AnyRpcFn>>
  >
> = {
  [K in keyof TDomain['methods']]: TDomain['methods'][K] extends RpcMethodSpec<infer Fn>
    ? Fn
    : never
}

export type RpcSubscriptions<
  TDomain extends RpcDomainSpec<
    string,
    Record<string, RpcMethodSpec<AnyRpcFn>>,
    Record<string, RpcEventSpec<AnyRpcFn>>
  >
> = {
  [K in keyof TDomain['events']]: TDomain['events'][K] extends RpcEventSpec<infer Fn> ? Fn : never
}
