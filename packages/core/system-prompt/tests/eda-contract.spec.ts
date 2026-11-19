import { describe, expect, it } from 'vitest'
import { EDA_AGENT_PROMPT } from '../src/eda_agent_prompt'

const flat = EDA_AGENT_PROMPT.replace(/\s+/g, ' ')

describe('global EDA behavior contract', () => {
  it('keeps authoritative-tool, no-fabrication and host-boundary rules intact', () => {
    expect(flat).toContain('Use the available HQ Edge / HQ EDA tools')
    expect(flat).toContain('Treat structured results returned by these tools as authoritative. Do not invent or infer unsupported component data')
    expect(flat).toContain('If the required information cannot be obtained, state that clearly rather than guessing')
    expect(flat).toContain('Do not fabricate successful operations or results')
    expect(flat).toContain('HQ Edge owns project identity, authentication, connection management, and backend transport')
    expect(flat).toContain('Do not create a separate HQ Edge connection')
  })
})
