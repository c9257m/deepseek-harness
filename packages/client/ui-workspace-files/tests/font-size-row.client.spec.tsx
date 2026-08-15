// @vitest-environment jsdom
/**
 * FontSizeRow behavior: shows the mirrored font size, steps within bounds via
 * the injected write, and disables at the bounds.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type { WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { FontSizeRowComponentProps } from '../src/client/FontSizeRow.tsx'
import { FontSizeRow } from '../src/client/FontSizeRow.tsx'
import { createFileBrowserStore } from '../src/client/stores.ts'
import { FONT_SIZE_MAX, FONT_SIZE_MIN } from '../src/settings.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t: FontSizeRowComponentProps['t'] = makeTranslate(zh, commonZh)

function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}

const workspaceState: WorkspaceListState = {
  items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  baselinesReady: true, recentWorkspaceId: undefined,
}

function mount() {
  const store = createFileBrowserStore().create()
  const setFontSize = vi.fn()
  const props: FontSizeRowComponentProps = {
    useSessions: hook({} as never),
    useWorkspaces: hook(workspaceState),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    setFontSize,
    t,
  }
  render(<FontSizeRow {...props} />)
  return { store, setFontSize }
}

describe('FontSizeRow', () => {
  it('renders the title and the mirrored size', () => {
    mount()
    expect(screen.getByText('文件字体大小')).toBeTruthy()
    expect(screen.getByText('12px')).toBeTruthy()
  })

  it('steps through the injected write and mirrors the store back', () => {
    const { store, setFontSize } = mount()
    fireEvent.click(screen.getByLabelText('增大字体'))
    expect(setFontSize).toHaveBeenCalledWith(13)
    act(() => { store.actions.setFontSize(16) })
    expect(screen.getByText('16px')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('减小字体'))
    expect(setFontSize).toHaveBeenCalledWith(15)
  })

  it('disables the steppers at the bounds', () => {
    const { store } = mount()
    act(() => { store.actions.setFontSize(FONT_SIZE_MAX) })
    expect((screen.getByLabelText('增大字体') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('减小字体') as HTMLButtonElement).disabled).toBe(false)
    act(() => { store.actions.setFontSize(FONT_SIZE_MIN) })
    expect((screen.getByLabelText('减小字体') as HTMLButtonElement).disabled).toBe(true)
  })
})
