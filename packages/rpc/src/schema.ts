export type RpcMode = 'invoke' | 'sync'

export interface RpcMethodSpec<Fn extends (...args: any[]) => any> {
  channel: string
  params: readonly string[]
  invokeArgs: readonly string[]
  mode: RpcMode
  implementation?: string
  __fn?: Fn
}

export interface RpcEventSpec<Fn extends (...args: any[]) => any> {
  channel: string
  __fn?: Fn
}

export interface RpcDomainSpec<
  Name extends string,
  Methods extends Record<string, RpcMethodSpec<any>>,
  Events extends Record<string, RpcEventSpec<any>>
> {
  name: Name
  methods: Methods
  events: Events
}

export function defineMethod<Fn extends (...args: any[]) => any>(config: {
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
  } as RpcMethodSpec<Fn>
}

export function defineEvent<Payload>(channel: string): RpcEventSpec<
  (callback: (payload: Payload) => void) => () => void
> {
  return { channel } as RpcEventSpec<(callback: (payload: Payload) => void) => () => void>
}

export function defineDomain<
  Name extends string,
  Methods extends Record<string, RpcMethodSpec<any>>,
  Events extends Record<string, RpcEventSpec<any>>
>(domain: RpcDomainSpec<Name, Methods, Events>): RpcDomainSpec<Name, Methods, Events> {
  return domain
}

export type RpcClient<TDomain extends RpcDomainSpec<string, Record<string, RpcMethodSpec<any>>, any>> =
  {
    [K in keyof TDomain['methods']]: TDomain['methods'][K] extends RpcMethodSpec<infer Fn>
      ? Fn
      : never
  }

export type RpcSubscriptions<
  TDomain extends RpcDomainSpec<string, any, Record<string, RpcEventSpec<any>>>
> = {
  [K in keyof TDomain['events']]: TDomain['events'][K] extends RpcEventSpec<infer Fn> ? Fn : never
}
