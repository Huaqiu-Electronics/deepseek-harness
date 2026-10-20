/**
 * Pack one release family's whole publish set into a single directory and
 * record its publish order for the publish step. Default serial packs execute
 * in that order; explicitly parallel packs use pnpm's bounded scheduler.
 *
 * The pack step is the release boundary: it runs without credentials, produces
 * every tarball from one commit, and hands the publish step exactly those bytes
 * ([rationale](../../.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md)).
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pnpmInvocation } from '../pnpm-invocation.ts'
import { releaseFamily, tarballName, type ReleaseFamily, type ReleaseMember } from './families.ts'
import { isEntry, runConcurrent } from './process.ts'
import { PUBLISH_ORDER_FILE, packedManifest, tarballFiles } from './tarball.ts'

/** Where pack output lands when `--out` is omitted. */
const DEFAULT_OUTPUT = 'dist/npm'

/**
 * Safest assembled command-line length (chars) for a single recursive pack on
 * every supported OS. On Windows, Node `spawn` with `shell: true` runs the
 * command through `cmd.exe`, whose batch-file per-line limit is 8191 chars —
 * NOT CreateProcess's 32767. Families grow unboundedly with packages: 0.2.1's
 * `dsh` family is 343 members ≈ 15k chars, which surfaces as "The command
 * line is too long." on Windows only (macOS' ~1MB ARG_MAX absorbs it). Chunks
 * are sized to keep every invocation safely under this budget.
 */
const MAX_SAFE_COMMAND_LINE = 7_000

/**
 * Check one member's expected tarball and its published files.
 * @param family - the release family being packed.
 * @param member - the member to pack.
 * @param destination - absolute output directory.
 * @returns The tarball filename.
 */
function validatePackedMember(family: ReleaseFamily, member: ReleaseMember, destination: string): string {
  const filename = tarballName(member)
  const tarball = join(destination, filename)
  if (!existsSync(tarball)) throw new Error(`${member.name} produced no tarball at ${tarball}`)
  family.validatePayload(member, tarballFiles(tarball))
  family.validatePackedManifest(member, packedManifest(tarball))
  return filename
}

/**
 * Pack serial members in publish order, or batch an explicitly parallel family.
 * @param family - Release family whose payload checks apply to every tarball.
 * @param members - Exact public members in the recorded publish order.
 * @param destination - Absolute output directory.
 * @param concurrency - Maximum active package packs; one preserves serial publication order.
 * @returns Validated tarball filenames in publish order.
 */
async function packMembers(
  family: ReleaseFamily, members: readonly ReleaseMember[], destination: string, concurrency: number,
): Promise<string[]> {
  if (concurrency === 1) {
    const order: string[] = []
    for (const member of members) {
      const invocation = pnpmInvocation(['--dir', member.directory, 'pack', '--pack-destination', destination])
      await runConcurrent(invocation.command, invocation.args)
      order.push(validatePackedMember(family, member, destination))
    }
    return order
  }
  if (members.length === 0) return []

  // A single `pnpm pack --recursive` with every member as a `--filter` grows
  // the assembled command line with the family size. On Windows that line is
  // routed through cmd.exe (8191-char batch cap), so large families fail with
  // "The command line is too long." while macOS succeeds. Split the --filter
  // list into chunks whose FULL command line stays under the budget; non-
  // Windows keeps a single invocation (unchanged behaviour). Each chunk still
  // packs with pnpm's own --workspace-concurrency, so the parallel pack is
  // preserved; chunks run sequentially so distinct pnpm processes never
  // contend on the same workspace.
  const fixedArgs = [
    'pack',
    '--recursive',
    `--workspace-concurrency=${String(concurrency)}`,
    '--pack-destination', destination,
  ]
  const fixed = pnpmInvocation([...fixedArgs])
  const fixedLength = fixed.command.length + 1 + fixed.args.join(' ').length
  const budget = process.platform === 'win32' ? MAX_SAFE_COMMAND_LINE : Number.POSITIVE_INFINITY

  const chunks: ReleaseMember[][] = []
  let chunk: ReleaseMember[] = []
  let chunkLength = fixedLength
  for (const member of members) {
    const added = `--filter=${member.name}`.length + 1
    if (chunk.length > 0 && chunkLength + added > budget) {
      chunks.push(chunk)
      chunk = []
      chunkLength = fixedLength
    }
    chunk.push(member)
    chunkLength += added
  }
  if (chunk.length > 0) chunks.push(chunk)

  for (const slice of chunks) {
    const invocation = pnpmInvocation([
      ...fixedArgs,
      ...slice.map(member => `--filter=${member.name}`),
    ])
    await runConcurrent(invocation.command, invocation.args)
  }
  return members.map(member => validatePackedMember(family, member, destination))
}

/**
 * @returns The validated `--concurrency` value; 1 (the default) packs the
 * members one at a time, exactly as the credentialed publish workflows run it.
 */
function parseConcurrency(raw: string | undefined): number {
  if (raw === undefined) return 1
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== raw) {
    throw new Error(`--concurrency must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return parsed
}

/** Pack the family named by `--family` into `--out`. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { family: { type: 'string' }, out: { type: 'string' }, concurrency: { type: 'string' } },
    allowPositionals: false,
  })
  if (values.family === undefined) throw new Error('usage: pack.ts --family <dsh|vendor> [--out dist/npm] [--concurrency 1]')
  const concurrency = parseConcurrency(values.concurrency)

  const family = releaseFamily(values.family)
  const root = process.cwd()
  const destination = resolve(root, values.out ?? DEFAULT_OUTPUT)
  const members = family.publishOrder(family.members(root)).order
  family.verifyBuildArtifacts(root)
  family.verifyVersions(members)

  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })

  const order = await packMembers(family, members, destination, concurrency)
  writeFileSync(join(destination, PUBLISH_ORDER_FILE), `${order.join('\n')}\n`)

  console.log(`release pack: family ${family.id}, ${String(order.length)} tarball(s) in ${values.out ?? DEFAULT_OUTPUT}`)
}

if (isEntry(import.meta.url)) await main()
