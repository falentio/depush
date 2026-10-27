// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import * as v from 'valibot'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { issuedAppSchema } from '@/api/contracts'
import { AppDialog } from '@/components/apps/app-dialog'
import { selectCopyValue } from '@/lib/copy'
import type { CommandState } from '@/lib/use-command'

const issued = v.parse(issuedAppSchema, {
  id: 'cynwips0',
  key: '0123456789abcdef0123456789abcdef',
  secret: 'fedcba9876543210fedcba9876543210',
  name: 'demo',
  created_at: 0,
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  localStorage.clear()
  sessionStorage.clear()
})

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find((element) =>
    element.textContent?.includes(label),
  )
  if (!(match instanceof HTMLButtonElement)) throw new Error(`missing button: ${label}`)
  return match
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('input value setter is missing')
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function Harness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(true)
  const [state, setState] = useState<CommandState<typeof issued>>({ status: 'idle' })

  async function create(): Promise<boolean> {
    setState({ status: 'succeeded', value: issued })
    return true
  }

  function close(): void {
    setState({ status: 'idle' })
    setOpen(false)
    onClose()
  }

  return open ? (
    <AppDialog open online state={state} onCreate={create} onClose={close} />
  ) : (
    <p>closed</p>
  )
}

describe('AppDialog secret acknowledgement', () => {
  it('shows the secret once and leaves no copy after acknowledgement', async () => {
    const onClose = vi.fn()
    await act(async () => {
      root.render(<Harness onClose={onClose} />)
    })

    const input = document.querySelector<HTMLInputElement>('input[name="name"]')
    if (input === null) throw new Error('name input is missing')
    await act(async () => {
      setInput(input, 'demo')
    })

    const form = document.querySelector('form')
    if (form === null) throw new Error('create form is missing')
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(document.body.textContent).toContain(issued.secret)
    expect(document.body.textContent).toContain('App created')

    await act(async () => {
      button("I've saved it").click()
    })

    expect(onClose).toHaveBeenCalledOnce()
    expect(document.body.textContent).not.toContain(issued.secret)
    expect(document.body.textContent).not.toContain(issued.key)
    expect(window.location.href).not.toContain(issued.secret)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('selects the .env block when the clipboard fails', async () => {
    await act(async () => {
      root.render(
        <AppDialog
          open
          online
          state={{ status: 'succeeded', value: issued }}
          onCreate={async () => true}
          onClose={() => undefined}
        />,
      )
    })

    await act(async () => {
      selectCopyValue(button('Copy .env'))
    })

    const selected = window.getSelection()?.toString() ?? ''
    expect(selected).toContain(`DEPUSH_APP_ID=${issued.id}`)
    expect(selected).toContain(`DEPUSH_APP_SECRET=${issued.secret}`)
  })
})
