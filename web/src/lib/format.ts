const createdAt = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

export function formatCreatedAt(value: Date): string {
  return createdAt.format(value)
}
