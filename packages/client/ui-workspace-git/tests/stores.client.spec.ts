// @vitest-environment jsdom
/**
 * createGitPanelStore unit account: the parsed status/branch facts and the
 * interaction draft. Uses the test-sanctioned path: factory self-call +
 * .create() gives the real engine instance (same create path as production).
 */
import { describe, expect, it } from 'vitest'
import { createGitPanelStore } from '../src/client/stores.ts'

describe('createGitPanelStore', () => {
  it('starts with the idle draft', () => {
    const { store } = createGitPanelStore().create()
    expect(store.getSnapshot()).toEqual({
      status: null, branches: [], commitMessage: '', busy: false,
      output: null, error: null, notRepo: false, changesHeight: 160,
    })
  })

  it('records the parsed status, branches, and interaction draft', () => {
    const { store, actions } = createGitPanelStore().create()
    const status = {
      branch: 'main', upstream: 'origin/main', ahead: 1, behind: 0,
      staged: [{ path: 'a.ts', status: 'M' }], unstaged: [], untracked: ['b.ts'], conflicted: [], clean: false,
    }
    actions.setStatus(status)
    actions.setBranches([{ name: 'main', current: true, upstream: null, ahead: 0, behind: 0, gone: false }])
    actions.setCommitMessage('fix it')
    actions.setBusy(true)
    actions.setOutput('Everything up-to-date')
    actions.setError('boom')
    actions.setNotRepo(true)
    expect(store.getSnapshot()).toMatchObject({
      status, commitMessage: 'fix it', busy: true, output: 'Everything up-to-date', error: 'boom', notRepo: true,
    })
    expect(store.getSnapshot().branches).toHaveLength(1)
  })
})
