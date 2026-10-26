import * as v from 'valibot'

export const appNameSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80))

export const createAppSchema = v.object({
  name: appNameSchema,
})

export const appSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  name: v.string(),
  createdAt: v.string(),
})

export type App = v.InferOutput<typeof appSchema>
