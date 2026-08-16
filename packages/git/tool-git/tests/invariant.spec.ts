import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as GitInvariant from '@deepseek-ai/dsh-tool-git/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

describe('tool-git invariant companion', () => {
  it('reserves the package name and stays inert without an event stream', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(GitInvariant)
    // The companion owns the package name: a second registration is rejected.
    expect(() => ctx.invariants.register('@deepseek-ai/dsh-tool-git', () => {})).toThrow(/already registered/)
    // The empty installer has no checks — this model-facing adapter owns no
    // independent lifecycle stream — so unrelated dispatches never throw.
    expect(() => { ctx.emit('tools/change') }).not.toThrow()
  })
})
