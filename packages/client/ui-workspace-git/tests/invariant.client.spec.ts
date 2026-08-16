import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as WorkspaceGitInvariant from '@deepseek-ai/dsh-client-ui-workspace-git/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

describe('ui-workspace-git invariant companion', () => {
  it('reserves the package name and stays inert without an event stream', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(WorkspaceGitInvariant)
    expect(() => ctx.invariants.register('@deepseek-ai/dsh-client-ui-workspace-git', () => {})).toThrow(/already registered/)
    expect(() => { ctx.emit('tools/change') }).not.toThrow()
  })

  it('node-half apply is a no-op host placeholder', async () => {
    const { apply } = await import('@deepseek-ai/dsh-client-ui-workspace-git')
    apply()
    expect(true).toBe(true) // reaching here without throw is the contract
  })
})
