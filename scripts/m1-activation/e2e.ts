/**
 * M1 §8 functional POC: execute real tools registered by the packed bundle
 * against the EDA hosts on this machine, and record the executed outcome.
 *
 * The bundle is booted by the same fixture that proved activation. Tools are
 * dispatched through the real `ToolsService.execute` path — not by calling a
 * plugin's `execute()` directly — so registration, guards, and error semantics
 * are all exercised. External services are allowed to be called (and their
 * failures are recorded verbatim); activation itself was proven separately
 * with outbound TCP blocked.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ToolCallBlock } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { activate } from './run.ts'

const HARNESS_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const PRODUCT_ROOT = resolve(fileURLToPath(new URL('../../../dsh-pcb-eda', import.meta.url)))

/** One tool invocation and its observed outcome. */
interface ToolExecution {
  readonly name: string
  readonly args: Record<string, unknown>
  readonly dispatched: boolean
  readonly isError: boolean | undefined
  readonly value: unknown
  readonly error: unknown
  readonly content: readonly string[]
  readonly elapsedMs: number
}

/**
 * Dispatch one tool call through the live ToolsService.
 * @param ctx - the booted DSH context.
 * @param name - registered tool name.
 * @param args - tool arguments.
 * @param index - call id suffix.
 * @returns the observed outcome, including a dispatch failure when one occurred.
 */
async function callTool(ctx: Context, name: string, args: Record<string, unknown>, index: number): Promise<ToolExecution> {
  const started = Date.now()
  try {
    const output = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: `m1-${index}` as ToolCallBlock['id'], name, arguments: JSON.stringify(args) }],
      signal: new AbortController().signal,
    })
    const result = output.results[0]?.result
    if (result === undefined) {
      return {
        name, args, dispatched: true, isError: undefined, value: undefined,
        error: 'tool executor returned no result', content: [], elapsedMs: Date.now() - started,
      }
    }
    return {
      name,
      args,
      dispatched: true,
      isError: result.isError,
      value: result.isError ? undefined : result.value,
      error: result.isError ? result.error : undefined,
      content: result.content.map((item) => {
        try { return JSON.stringify(item) } catch { return String(item) }
      }),
      elapsedMs: Date.now() - started,
    }
  } catch (error) {
    return {
      name, args, dispatched: false, isError: true, value: undefined,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      content: [], elapsedMs: Date.now() - started,
    }
  }
}

/** The representative workflow, in the order a hardware task would use it. */
const WORKFLOW: readonly { name: string; args: Record<string, unknown> }[] = [
  { name: 'kicad_ipc_diagnose', args: {} },
  { name: 'kicad_ipc_verify_live', args: {} },
  { name: 'search_hqsch_parts', args: { query: 'STM32F103', page: 1, page_size: 3, require_eda_model: true } },
  { name: 'quote_pcb', args: { region: 'cn' } },
]

/** CLI entry. */
async function main(): Promise<void> {
  const outDir = join(HARNESS_ROOT, 'scripts/m1-activation/out')
  mkdirSync(outDir, { recursive: true })
  const evidence = await activate({
    distDir: join(PRODUCT_ROOT, 'dist'),
    version: '0.7.10',
    family: 'desktop',
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@huaqiu/hardware-engineering'],
    networkMode: 'record',
    exercise: async (ctx) => {
      const executions: ToolExecution[] = []
      for (const [index, step] of WORKFLOW.entries()) {
        executions.push(await callTool(ctx, step.name, step.args, index + 1))
      }
      return executions
    },
  })
  writeFileSync(join(outDir, 'e2e-desktop.json'), `${JSON.stringify(evidence, undefined, 2)}\n`)
  const executions = evidence.exercise as ToolExecution[]
  const lines = [
    '# M1 §8 — executed functional POC',
    '',
    `activation checks: ${evidence.checks.filter(check => check.ok).length}/${evidence.checks.length} PASS`,
    `network: ${evidence.network.total} connect attempts`,
    '',
    '| Step | Tool | Dispatched | isError | Elapsed |',
    '|---|---|---|---|---|',
    ...executions.map((execution, index) => `| ${index + 1} | ${execution.name} | ${execution.dispatched} | ${String(execution.isError)} | ${execution.elapsedMs}ms |`),
    '',
  ]
  for (const [index, execution] of executions.entries()) {
    lines.push(`## ${index + 1}. ${execution.name}`, '', 'args:')
    lines.push(`  ${JSON.stringify(execution.args)}`)
    lines.push('result:')
    lines.push(`  ${JSON.stringify({ value: execution.value, error: execution.error, content: execution.content }, undefined, 2)}`)
    lines.push('')
  }
  const rendered = `${lines.join('\n').trimEnd()}\n`
  writeFileSync(join(outDir, 'e2e-desktop.log'), rendered)
  process.stdout.write(rendered)
  process.exit(0)
}

await main()
