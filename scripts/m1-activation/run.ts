/**
 * Boot the packed Huaqiu product bundle in a real DSH profile and record what
 * actually happened.
 *
 * This is the activation proof for M1 §7: a real `runProfile` boot (no mocked
 * `boot`, no mocked plugin `apply()`), against a throwaway installation built
 * from the packed tarballs, with outbound TCP blocked and no HQ Edge service on
 * the machine. Evidence is written as JSON plus a human-readable log so the
 * report can cite rows, versions, and directories rather than a screenshot.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { composeEntries, loadProfile, resolveBundleDir } from '@deepseek-ai/dsh-app-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { runProfile } from '../../apps/cli/src/profile-boot.ts'
import { buildInstallationFixture, discardFixture, PRODUCT_BUNDLE, type InstallationFixture } from './fixture.ts'
import { installNetworkGuard, type NetworkAttempt } from './network-guard.ts'

const HARNESS_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))

/** The nine rows the product bundle must mount. */
export const EXPECTED_ROWS = [
  'huaqiu-auth',
  'huaqiu-artifacts',
  'huaqiu-dsh-kicad',
  'dsh-tool-kicad-schematic-gen',
  'huaqiu-tool-part-search',
  'huaqiu-tool-quote',
  'huaqiu-tool-symbol-footprint',
  'ui-theme-huaqiu',
  'dsh-huaqiu-about',
] as const

/** Tools that must be registered by those rows, grouped by the plugin that owns them. */
export const EXPECTED_TOOLS: Readonly<Record<string, readonly string[]>> = {
  '@huaqiu/dsh-kicad': [
    'kicad_pcb_create_track', 'kicad_pcb_create_via', 'kicad_pcb_refill_zones',
    'kicad_pcb_create_copper_zone', 'kicad_ipc_diagnose', 'kicad_ipc_verify_live',
  ],
  '@huaqiu/dsh-tool-kicad-schematic-gen': [
    'analyze_kicad_module', 'create_kicad_hierarchy', 'import_kicad_symbol', 'edit_kicad_flat_schematic',
  ],
  '@huaqiu/dsh-tool-part-search': [
    'search_hqsch_parts', 'get_hqsch_part', 'get_hqsch_part_models', 'get_hqsch_supply_chain',
  ],
  '@huaqiu/dsh-tool-quote': ['quote_pcb', 'quote_smt', 'place_pcb_order', 'place_smt_order'],
  '@huaqiu/dsh-tool-symbol-footprint': [
    'generate_symbol_from_image', 'generate_footprint_from_image', 'generate_footprint_from_dimensions',
  ],
}

/** One Loader row as observed after startup settled. */
export interface RowObservation {
  /** Loader-scoped id, e.g. `include:huaqiu-auth`. */
  readonly id: string
  /** The id as written in the patch, e.g. `huaqiu-auth`. */
  readonly rawId: string
  readonly module: string
  readonly version: string | undefined
  readonly dir: string | undefined
  readonly state: 'disabled' | 'pending' | 'loading' | 'active' | 'failed' | 'disposed' | 'unloading'
  readonly missing: readonly string[]
  readonly error: string | undefined
}

/** One assertion with the evidence behind it. */
export interface Check {
  readonly id: string
  readonly ok: boolean
  readonly detail: string
}

/** Everything one activation run observed. */
export interface ActivationEvidence {
  readonly family: string
  readonly version: string
  readonly installAnchor: string
  readonly profileDir: string
  readonly home: string
  readonly bundles: readonly string[]
  readonly closure: readonly { name: string; kind: 'packed' | 'published'; version: string }[]
  readonly installed: readonly { name: string; version: string; directory: string }[]
  readonly bundleDir: string | undefined
  readonly bundleVersion: string | undefined
  readonly productRows: readonly string[]
  readonly rows: readonly RowObservation[]
  readonly tools: readonly string[]
  readonly skills: readonly string[]
  readonly services: readonly string[]
  readonly sandboxDefaultMode: string | undefined
  /** Teardown is recorded but never allowed to hide activation evidence. */
  readonly teardown: { readonly requestedExit: number | undefined; readonly error: string | undefined }
  readonly exercise: unknown
  readonly permissionModeEnv: string | undefined
  readonly network: { readonly total: number; readonly blocked: readonly NetworkAttempt[] }
  readonly stderr: readonly string[]
  readonly checks: readonly Check[]
  readonly ok: boolean
  readonly fatal: string | undefined
}

/**
 * Whether a resolved package directory lies in a fixture. Both paths are
 * canonicalised: macOS reports `/var/...` in some resolution paths and
 * `/private/var/...` in others.
 * @param directory - candidate directory.
 * @param root - fixture installation root.
 * @returns true when the directory is inside the fixture.
 */
function insideFixture(directory: string | undefined, root: string): boolean {
  if (directory === undefined) return false
  try {
    const canonical = realpathSync(directory)
    const canonicalRoot = realpathSync(root)
    return canonical === canonicalRoot || canonical.startsWith(`${canonicalRoot}/`)
  } catch {
    return false
  }
}

/** Fiber state numbers, per cordis `FiberState`. */
const STATES: Readonly<Record<number, RowObservation['state']>> = {
  0: 'pending', 1: 'loading', 2: 'active', 3: 'failed', 4: 'disposed', 5: 'unloading',
}

/**
 * Read every Loader row with the package it actually resolved to.
 * @param ctx - the booted context.
 * @returns rows in Loader order.
 */
function observeRows(ctx: Context): RowObservation[] {
  const packages = ctx.get('pluginPackages')
  return [...ctx.loader.entries()].map((entry) => {
    const source = entry.parent.tree.ctx.baseUrl
    let version: string | undefined
    let dir: string | undefined
    try {
      const resolved = source === undefined ? undefined : packages?.packageOf(entry.options.name, source)
      version = resolved?.version
      dir = resolved?.dir
    } catch {
      // Package metadata is evidence, never a reason to lose the row itself.
    }
    const fiber = entry.fiber
    const state = entry.disabled
      ? 'disabled'
      : fiber === undefined ? 'failed' : STATES[fiber.state] ?? 'failed'
    return {
      id: entry.id,
      rawId: entry.options.id,
      module: entry.options.name,
      version,
      dir,
      state,
      missing: state === 'pending' && fiber !== undefined
        ? Object.keys(fiber.inject).filter(name => fiber.ctx.get(name) === undefined)
        : [],
      error: undefined,
    }
  })
}

/** Parse `--flag value` / `--flag` pairs. */
function parseArgs(argv: readonly string[]): Record<string, string | true> {
  const parsed: Record<string, string | true> = {}
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] as string
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      parsed[key] = next
      index++
    } else {
      parsed[key] = true
    }
  }
  return parsed
}

/**
 * Run one activation and return its evidence.
 * @param options - dist directory, version, and profile family.
 * @returns the evidence, whether or not activation succeeded.
 */
export async function activate(options: {
  distDir: string
  version: string
  family: 'desktop' | 'headless'
  bundles: readonly string[]
  negative?: 'missing-provider' | undefined
  /** `block` (default) proves offline activation; `record` allows E2E service calls. */
  networkMode?: 'block' | 'record'
  /** Optional real tool-execution pass, run after activation and before teardown. */
  exercise?: (ctx: Context) => Promise<unknown>
}): Promise<ActivationEvidence> {
  const fixture: InstallationFixture = buildInstallationFixture({
    distDir: options.distDir,
    harnessRoot: HARNESS_ROOT,
    version: options.version,
    bundles: options.bundles,
    profileName: 'hardware-engineering',
  })
  if (options.negative === 'missing-provider') {
    // Remove the provider a consumer row declares so the negative control shows
    // what a broken dependency list looks like, rather than trusting that the
    // checks would have caught it.
    const victim = join(fixture.installationDir, 'node_modules/@huaqiu/dsh-auth')
    if (existsSync(victim)) rmSync(victim, { recursive: true, force: true })
  }

  const stderrLines: string[] = []
  const originalStderr = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk)
    for (const line of text.split('\n')) if (line.trim() !== '') stderrLines.push(line)
    return Reflect.apply(originalStderr, process.stderr, [chunk, ...rest]) as boolean
  }) as typeof process.stderr.write

  const guard = installNetworkGuard({ block: options.networkMode !== 'record' })
  const checks: Check[] = []
  let fatal: string | undefined
  let rows: RowObservation[] = []
  let tools: string[] = []
  let skills: string[] = []
  let services: string[] = []
  let sandboxDefaultMode: string | undefined
  let bundleDir: string | undefined
  let bundleVersion: string | undefined
  let productRows: string[] = []
  let forcedExit: number | undefined
  let disposeError: string | undefined
  let exerciseResult: unknown

  process.env.DSH_HOME = fixture.home
  process.env.DSH_TELEMETRY_DISABLED = '1'
  delete process.env.DSH_PERMISSION_MODE
  const permissionModeEnv = process.env.DSH_PERMISSION_MODE

  try {
    const profile = loadProfile('dsh', fixture.profileName, fixture.installAnchor, fixture.home)
    checks.push({
      id: 'no-skipped-bundles',
      ok: profile.skippedBundles.length === 0,
      detail: profile.skippedBundles.length === 0
        ? 'every selected bundle loaded'
        : `skipped: ${profile.skippedBundles.map(s => `${s.packageName} (${s.reason})`).join(', ')}`,
    })
    checks.push({
      id: 'bundle-layer-present',
      ok: profile.layers.some(layer => layer.packageName === PRODUCT_BUNDLE),
      detail: `layers: ${profile.layers.map(layer => layer.packageName).join(', ')}`,
    })

    // Resolve the same way boot will, so a resolution failure is reported as a
    // check rather than as an opaque stack trace.
    bundleDir = resolveBundleDir('dsh', PRODUCT_BUNDLE, fixture.installAnchor, profile.dir)
    bundleVersion = (JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')) as { version?: string }).version
    checks.push({
      id: 'bundle-resolves-from-installation',
      ok: insideFixture(bundleDir, fixture.installationDir),
      detail: `${String(bundleDir)} (inside fixture installation: ${String(insideFixture(bundleDir, fixture.installationDir))})`,
    })
    checks.push({
      id: 'bundle-patch-shipped',
      ok: existsSync(join(bundleDir, 'cordis.patch.yml')),
      detail: join(bundleDir, 'cordis.patch.yml'),
    })
    checks.push({
      id: 'bundle-version-is-packed',
      ok: bundleVersion === options.version,
      detail: `resolved ${String(bundleVersion)}, packed ${options.version}`,
    })

    const composed = composeEntries(profile.layers.map(layer => layer.patches))
    productRows = composed.filter(row => (EXPECTED_ROWS as readonly string[]).includes(row.id)).map(row => row.id)
    const edgeInjectors = composed.filter((row) => {
      const inject = row.inject
      const names = Array.isArray(inject) ? inject : typeof inject === 'object' && inject !== null ? Object.keys(inject) : []
      return names.includes('hqEdge')
    }).map(row => row.id)
    checks.push({
      id: 'no-row-requires-hq-edge',
      ok: edgeInjectors.length === 0,
      detail: edgeInjectors.length === 0 ? 'no composed row injects hqEdge' : `rows inject hqEdge: ${edgeInjectors.join(', ')}`,
    })

    const environment = createLaunchEnvironmentSnapshot([
      { source: 'process', values: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ) },
    ])
    const { ctx, shutdown } = await runProfile({
      environment,
      profile: fixture.profileName,
      resolvedProfile: { profile, installAnchor: fixture.installAnchor },
      patchFiles: [],
      args: ['--port', '0', '--no-open'],
    })
    rows = observeRows(ctx)
    const schemaTools = ctx.get('tools') as { schemas(): { name: string }[] } | undefined
    tools = schemaTools?.schemas().map(tool => tool.name).sort() ?? []
    const registry = ctx.get('skills') as { list(lookup: unknown): Promise<{ name: string }[]> } | undefined
    if (registry !== undefined) {
      try {
        skills = (await registry.list({})).map(skill => skill.name).sort()
      } catch (error) {
        skills = [`<skills.list failed: ${error instanceof Error ? error.message : String(error)}>`]
      }
    }
    services = ['webServer', 'tools', 'skills', 'systemPrompt', 'sandboxPolicy', 'sessions', 'fs',
      'huaqiuAuth', 'huaqiuArtifacts']
      .filter(name => ctx.get(name) !== undefined)
    sandboxDefaultMode = (ctx.get('sandboxPolicy') as { defaultMode?: string } | undefined)?.defaultMode
    if (options.exercise !== undefined) exerciseResult = await options.exercise(ctx)
    // `ProcessShutdown` escalates to a real `process.exit` when the mounted tree
    // does not dispose, which would kill this fixture before its evidence reached
    // disk. Record the request instead of honouring it, so teardown health is an
    // observation rather than a way to lose the run.
    const realExit = process.exit.bind(process)
    process.exit = ((code?: number) => {
      forcedExit = code ?? 0
      throw new Error(`m1-activation: teardown requested process.exit(${String(code)})`)
    }) as typeof process.exit
    const pendingShutdown = shutdown.shutdown(0)
    // A shutdown whose promise never settles is an observation, not a reason to
    // lose the evidence: attach a catch so a late force-exit cannot surface as
    // an uncaught exception, and stop waiting after one second.
    void pendingShutdown.catch((error: unknown) => {
      disposeError ??= error instanceof Error ? error.message : String(error)
    })
    try {
      await Promise.race([
        pendingShutdown,
        new Promise<void>((done) => { setTimeout(done, 1_000) }),
      ])
      if (forcedExit === undefined && disposeError === undefined) {
        disposeError = 'did not settle within 1000 ms'
      }
    } finally {
      process.exit = realExit
    }
  } catch (error) {
    fatal = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  } finally {
    guard.restore()
    process.stderr.write = originalStderr
  }

  const rowById = new Map(rows.map(row => [row.rawId, row]))
  const missingRows = EXPECTED_ROWS.filter(id => !rowById.has(id))
  const inactiveRows = EXPECTED_ROWS
    .map(id => rowById.get(id))
    .filter((row): row is RowObservation => row !== undefined && row.state !== 'active')
  checks.push({
    id: 'expected-rows-mounted',
    ok: missingRows.length === 0,
    detail: missingRows.length === 0
      ? `all ${EXPECTED_ROWS.length} product rows are in the Loader tree`
      : `missing: ${missingRows.join(', ')}`,
  })
  checks.push({
    id: 'expected-rows-active',
    ok: inactiveRows.length === 0 && rows.length > 0,
    detail: inactiveRows.length === 0
      ? `all ${EXPECTED_ROWS.length} product rows reached ACTIVE`
      : inactiveRows.map(row => `${row.id}=${row.state}${row.missing.length === 0 ? '' : ` missing ${row.missing.join('+')}`}`).join(', '),
  })
  const rowsFromFixture = rows.filter(row => insideFixture(row.dir, fixture.installationDir))
  const productRowsFromFixture = productRows.filter(id => insideFixture(rowById.get(id)?.dir, fixture.installationDir))
  checks.push({
    id: 'rows-resolve-into-fixture-installation',
    ok: productRowsFromFixture.length === EXPECTED_ROWS.length,
    detail: `${productRowsFromFixture.length}/${EXPECTED_ROWS.length} product rows and ${rowsFromFixture.length}/${rows.length} total rows resolved inside the fixture installation`,
  })
  for (const [owner, expected] of Object.entries(EXPECTED_TOOLS)) {
    const missing = expected.filter(name => !tools.includes(name))
    checks.push({
      id: `tools-registered:${owner}`,
      ok: missing.length === 0,
      detail: missing.length === 0 ? `all ${expected.length} tools present` : `missing: ${missing.join(', ')}`,
    })
  }
  const kicadSkills = skills.filter(name => name.includes('kicad'))
  checks.push({
    id: 'skills-registered',
    ok: kicadSkills.length > 0,
    detail: kicadSkills.length > 0 ? kicadSkills.join(', ') : `no kicad skill in [${skills.join(', ')}]`,
  })
  for (const service of ['huaqiuAuth', 'huaqiuArtifacts', 'webServer', 'tools', 'sandboxPolicy']) {
    checks.push({
      id: `service-provided:${service}`,
      ok: services.includes(service),
      detail: services.includes(service) ? 'present' : 'absent',
    })
  }
  checks.push({
    id: 'sandbox-default-preserved',
    ok: sandboxDefaultMode === 'danger-full-access',
    detail: `sandboxPolicy.defaultMode=${String(sandboxDefaultMode)} (DSH_PERMISSION_MODE ${permissionModeEnv === undefined ? 'unset' : `= ${permissionModeEnv}`})`,
  })
  const blocked = guard.attempts.filter(attempt => !attempt.allowed)
  checks.push({
    id: options.networkMode === 'record' ? 'network-attempts-recorded' : 'activated-without-network',
    ok: options.networkMode === 'record' || blocked.length === 0,
    detail: `${guard.attempts.length} connect attempts, ${blocked.length} blocked`
      + (blocked.length === 0 ? '' : `: ${blocked.map(a => `${a.host}:${String(a.port)}`).join(', ')}`),
  })
  const warnings = stderrLines.filter(line => /did not activate|failed to (?:import|load)|cannot resolve/iu.test(line))
  checks.push({
    id: 'startup-reported-no-failures',
    ok: warnings.length === 0,
    detail: warnings.length === 0 ? 'no activation warnings on stderr' : warnings.join(' | '),
  })

  const evidence: ActivationEvidence = {
    family: options.family,
    version: options.version,
    installAnchor: fixture.installAnchor,
    profileDir: fixture.profileDir,
    home: fixture.home,
    bundles: options.bundles,
    closure: fixture.closure.map(entry => ({ name: entry.name, kind: entry.kind, version: entry.version })),
    installed: fixture.packages.map(pkg => ({ name: pkg.name, version: pkg.version, directory: pkg.directory })),
    bundleDir,
    bundleVersion,
    productRows,
    rows,
    tools,
    skills,
    services,
    sandboxDefaultMode,
    teardown: { requestedExit: forcedExit, error: disposeError },
    exercise: exerciseResult,
    permissionModeEnv,
    network: { total: guard.attempts.length, blocked },
    stderr: stderrLines,
    checks,
    ok: fatal === undefined && checks.every(check => check.ok),
    fatal,
  }
  discardFixture(fixture)
  return evidence
}

/** Render evidence as the log a reviewer reads. */
function renderLog(evidence: ActivationEvidence): string {
  const lines = [
    `# M1 activation — ${evidence.family} family, @huaqiu/hardware-engineering@${evidence.version}`,
    '',
    `installation anchor : ${evidence.installAnchor}`,
    `profile             : ${evidence.profileDir}`,
    `DSH_HOME            : ${evidence.home}`,
    `bundles             : ${evidence.bundles.join(', ')}`,
    `resolved bundle     : ${String(evidence.bundleDir)} @ ${String(evidence.bundleVersion)}`,
    `declared closure    : ${evidence.closure.map(e => `${e.name}@${e.version} (${e.kind})`).join(', ')}`,
    '',
    '## Loader rows',
    ...evidence.rows.map(row => `  ${row.state.padEnd(9)} ${row.id.padEnd(32)} ${row.version ?? '?'}  ${row.module}`),
    '',
    '## Registered tools',
    `  ${evidence.tools.length} tools: ${evidence.tools.join(', ')}`,
    '',
    '## Skills',
    `  ${evidence.skills.join(', ')}`,
    '',
    '## Services',
    `  ${evidence.services.join(', ')}`,
    `  sandboxPolicy.defaultMode = ${String(evidence.sandboxDefaultMode)}`,
    `  teardown: requestedExit=${String(evidence.teardown.requestedExit)} error=${String(evidence.teardown.error)}`,
    '',
    '## Exercise',
    ...(evidence.exercise === undefined
      ? ['  (none)']
      : JSON.stringify(evidence.exercise, undefined, 2).split('\n').map(line => `  ${line}`)),
    '',
    '## Network',
    `  ${evidence.network.total} connect attempts, ${evidence.network.blocked.length} blocked`,
    '',
    '## Checks',
    ...evidence.checks.map(check => `  ${check.ok ? 'PASS' : 'FAIL'}  ${check.id} — ${check.detail}`),
    '',
    `## Result: ${evidence.ok ? 'PASS' : 'FAIL'}${evidence.fatal === undefined ? '' : ` — ${evidence.fatal}`}`,
    '',
    '## stderr',
    ...(evidence.stderr.length === 0 ? ['  (empty)'] : evidence.stderr.map(line => `  ${line}`)),
    '',
  ]
  return `${lines.join('\n').trimEnd()}\n`
}

/** CLI entry. */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const distDir = typeof args.dist === 'string' ? args.dist : '/Users/admin/code/dsh-pcb-eda/dist'
  const version = typeof args.version === 'string' ? args.version : '0.7.10'
  const outDir = typeof args.out === 'string' ? args.out : join(HARNESS_ROOT, 'scripts/m1-activation/out')
  const family = args.family === 'headless' ? 'headless' : 'desktop'
  const bundles = family === 'desktop'
    ? ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', PRODUCT_BUNDLE]
    : ['@deepseek-ai/dsh-base', PRODUCT_BUNDLE]
  const negative = args.negative === 'missing-provider' ? 'missing-provider' as const : undefined

  mkdirSync(outDir, { recursive: true })
  const evidence = await activate({ distDir, version, family, bundles, negative })
  const suffix = negative === undefined ? family : `${family}-negative-${negative}`
  writeFileSync(join(outDir, `activation-${suffix}.json`), `${JSON.stringify(evidence, undefined, 2)}\n`)
  writeFileSync(join(outDir, `activation-${suffix}.log`), renderLog(evidence))
  process.stdout.write(renderLog(evidence))
  process.exit(evidence.ok ? 0 : 1)
}

// Only run when executed directly; importing the module supplies `activate`.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main()
}
