import * as v from 'valibot'

declare const brand: unique symbol

type Brand<T, B extends string> = T & { readonly [brand]: B }

export type AppId = Brand<string, 'AppId'>
export type AppKey = Brand<string, 'AppKey'>
export type AppSecret = Brand<string, 'AppSecret'>

export type App = {
  id: AppId
  key: AppKey
  name: string
  createdAt: Date
}

export type IssuedApp = App & { secret: AppSecret }

export type Settings = { signupEnabled: boolean }

export type User = { id: string; email: string; name: string; role: 'admin' | 'user' }

const appIdSchema = v.pipe(
  v.string(),
  v.regex(/^[a-z0-9]{8}$/, 'app id is not valid'),
  v.transform((value): AppId => value as AppId),
)

const appKeySchema = v.pipe(
  v.string(),
  v.regex(/^[0-9a-f]{32}$/, 'app key is not valid'),
  v.transform((value): AppKey => value as AppKey),
)

const appSecretSchema = v.pipe(
  v.string(),
  v.regex(/^[0-9a-f]{32}$/, 'app secret is not valid'),
  v.transform((value): AppSecret => value as AppSecret),
)

const appWireFields = {
  id: appIdSchema,
  key: appKeySchema,
  name: v.string(),
  created_at: v.number(),
}

const appWireSchema = v.object(appWireFields)

type AppWire = v.InferOutput<typeof appWireSchema>

function toApp(wire: AppWire): App {
  return {
    id: wire.id,
    key: wire.key,
    name: wire.name,
    createdAt: new Date(wire.created_at),
  }
}

export const appSchema = v.pipe(appWireSchema, v.transform(toApp))

export const appsSchema = v.array(appSchema)

export const issuedAppSchema = v.pipe(
  v.object({ ...appWireFields, secret: appSecretSchema }),
  v.transform(
    (wire): IssuedApp => ({
      ...toApp(wire),
      secret: wire.secret,
    }),
  ),
)

export const settingsSchema = v.pipe(
  v.object({ signup_enabled: v.boolean() }),
  v.transform((wire): Settings => ({ signupEnabled: wire.signup_enabled })),
)

const sessionWireSchema = v.nullable(
  v.object({
    user: v.object({
      id: v.string(),
      email: v.string(),
      name: v.string(),
      role: v.nullable(v.string()),
    }),
  }),
)

export const sessionSchema = sessionWireSchema

export type Session = NonNullable<v.InferOutput<typeof sessionWireSchema>>

export const errorBodySchema = v.object({
  error: v.optional(v.string()),
  message: v.optional(v.string()),
})
