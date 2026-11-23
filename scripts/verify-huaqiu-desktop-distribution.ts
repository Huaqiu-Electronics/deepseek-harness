/**
 * Verify the Huaqiu Hardware Engineering Desktop distribution's static contract.
 *
 * The product bundle `@huaqiu/hardware-engineering` is published to the registry, so
 * the distribution must consume it through plain registry resolution: an exact
 * `0.7.10` declaration in `apps/cli`, an integrity-bearing lockfile entry, and no
 * `link:`/`file:` artifact left over from the M1/M2 local-tarball phase. Everything
 * else that can be proven without launching the packaged application lives here —
 * the installed bundle still carries its patch, every patch row resolves to a
 * published package, no row gates on the HQ Edge service, the Desktop profile keeps
 * selecting the bundle, the sandbox default survives, and the branding stays Huaqiu's.
 *
 * The packed-runtime half — the application starting and activating the eleven rows —
 * is `apps/desktop/scripts/smoke-packaged-runtime.ts`, run after packaging.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { PROFILE_TEMPLATES } from '../packages/util/official-bundles/src/bundles.ts'
import { loadCordisYaml } from './cordis-yaml.ts'

/** Product bundle name; the one name the Desktop profile selects. */
export const PRODUCT_BUNDLE = '@huaqiu/hardware-engineering'
/** Published product version every Huaqiu package in the closure must agree on. */
export const PRODUCT_VERSION = '0.7.12'
/** Installation that must declare the bundle: the runtime `dsh` package. */
export const INSTALLATION_MANIFEST = 'apps/cli/package.json'
/** Desktop profile the product bundle must be selected by. */
export const DESKTOP_PROFILE = 'desktop'
/** Sandbox default the Huaqiu fork requires, restated here so a regression fails a gate. */
export const SANDBOX_DEFAULT = 'danger-full-access'

interface PatchRow {
  name?: unknown
  disabled?: unknown
  inject?: unknown
}

/** One named check with its outcome. */
export interface DistributionCheck {
  readonly id: string
  readonly failure?: string
}

/** Aggregate result for the report and the process exit code. */
export interface DistributionResult {
  checks: DistributionCheck[]
  failures: string[]
}

function readJson(path: string): Record<string, unknown> {
  const text = readText(path)
  if (text === undefined) return {}
  try { return JSON.parse(text) as Record<string, unknown> } catch { return {} }
}

/** Read a text file, or `undefined` when it is absent; a gate reports absence instead of throwing. */
function readText(path: string): string | undefined {
  try { return readFileSync(path, 'utf8') } catch { return undefined }
}

/** Collect the `inject` arrays a plugin distribution file declares. */
export function injectedServices(source: string): string[] {
  const services: string[] = []
  for (const match of source.matchAll(/inject\s*[:=]\s*\[([^\]]*)\]/gu)) {
    for (const quoted of (match[1] ?? '').matchAll(/['"]([^'"]+)['"]/gu)) {
      const service = quoted[1]
      if (service !== undefined) services.push(service)
    }
  }
  return services
}

/** Patch rows of a bundle's `cordis.patch.yml`, including nested `insert` lists. */
export function patchRowsOf(patch: string): PatchRow[] {
  const document = loadCordisYaml(patch)
  if (!Array.isArray(document)) return []
  const rows: PatchRow[] = []
  const visit = (entries: unknown[]): void => {
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue
      rows.push(entry as PatchRow)
      const nested = (entry as { insert?: unknown }).insert
      if (Array.isArray(nested)) visit(nested)
    }
  }
  visit(document)
  return rows
}

/**
 * Registry packages the lockfile resolves, keyed by name.
 * @param lockfile - Parsed `pnpm-lock.yaml`.
 * @returns Name → integrity for every `@huaqiu/*` package, plus any entry without one.
 */
export function publishedHuaqiuPackages(lockfile: unknown): { resolved: Map<string, string>; unverified: string[] } {
  const resolved = new Map<string, string>()
  const unverified: string[] = []
  const packages = (lockfile as { packages?: Record<string, { resolution?: { integrity?: unknown } }> } | undefined | null)?.packages ?? {}
  for (const [key, value] of Object.entries(packages)) {
    const name = key.replace(/^'+|'+$/gu, '').replace(/@[^@/]+$/u, '')
    if (!name.startsWith('@huaqiu/')) continue
    const integrity = value?.resolution?.integrity
    if (typeof integrity === 'string' && integrity.startsWith('sha512-')) resolved.set(name, integrity)
    else unverified.push(key)
  }
  return { resolved, unverified }
}

/**
 * Verify the static distribution contract.
 * @param root - Repository root.
 * @returns Every check, in report order, plus the failures to print.
 */
export async function verifyHuaqiuDesktopDistribution(root: string): Promise<DistributionResult> {
  const checks: DistributionCheck[] = []
  const check = (id: string, failure?: string): void => { checks.push(failure === undefined ? { id } : { id, failure }) }

  // 1. The installation declares the published bundle at an exact version.
  const installation = readJson(join(root, INSTALLATION_MANIFEST)) as { dependencies?: Record<string, string> }
  const declared = installation.dependencies?.[PRODUCT_BUNDLE]
  const exact = new RegExp(`^${PRODUCT_VERSION.replaceAll('.', '\\.')}$`, 'u')
  check('installation-declares-bundle', declared !== undefined && exact.test(declared)
    ? undefined : `${INSTALLATION_MANIFEST} declares ${String(declared)} for ${PRODUCT_BUNDLE}, expected ${PRODUCT_VERSION}`)

  // 2. No local artifact bridge survives: no `link:`/`file:` override, no packed product directory.
  const workspace = (yaml.load(readText(join(root, 'pnpm-workspace.yaml')) ?? '') ?? {}) as {
    overrides?: Record<string, string>
  }
  const localInstalls = Object.entries(workspace.overrides ?? {})
    .filter(([name, spec]) => name.startsWith('@huaqiu/') && (spec.startsWith('link:') || spec.startsWith('file:')))
    .map(([name, spec]) => `${name}: ${spec}`)
  const packedProduct = ['pnpm-workspace.yaml', 'pnpm-lock.yaml', 'apps/cli/package.json']
    .filter(file => (readText(join(root, file)) ?? '').includes('product/huaqiu'))
  check('no-local-package-bridge', localInstalls.length === 0 && packedProduct.length === 0
    ? undefined
    : [
      ...localInstalls.map(entry => `workspace override installs a local artifact: ${entry}`),
      ...packedProduct.map(file => `${file} still names the packed product directory`),
    ].join('; '))

  // 3. The lockfile resolves every Huaqiu package from the registry with integrity.
  const lockfile = yaml.load(readText(join(root, 'pnpm-lock.yaml')) ?? '') as unknown
  const { resolved, unverified } = publishedHuaqiuPackages(lockfile)
  const registryProblems: string[] = [...unverified.map(key => `${key} has no registry integrity`)]
  const bundleIntegrity = resolved.get(PRODUCT_BUNDLE)
  if (bundleIntegrity === undefined) registryProblems.push(`${PRODUCT_BUNDLE} is not resolved from the registry`)
  if (resolved.size < 16) registryProblems.push(`only ${String(resolved.size)} Huaqiu packages resolve from the registry, expected at least 16`)
  check('registry-resolution', registryProblems.length === 0 ? undefined : registryProblems.join('; '))

  // 4. The installed bundle is a bundle, ships its patch, and is not offered as a plugin.
  const installedRoot = join(root, 'apps/cli/node_modules', PRODUCT_BUNDLE)
  const manifestText = readText(join(installedRoot, 'package.json'))
  const patchText = readText(join(installedRoot, 'cordis.patch.yml'))
  const manifestProblems: string[] = []
  if (manifestText === undefined) {
    manifestProblems.push(`${PRODUCT_BUNDLE} is not installed (run pnpm install)`)
  } else {
    const parsed = JSON.parse(manifestText) as {
      name?: string
      version?: string
      dsh?: { bundle?: { patch?: string; listedByDefault?: boolean } }
      engines?: Record<string, string>
      dependencies?: Record<string, string>
    }
    if (parsed.name !== PRODUCT_BUNDLE) manifestProblems.push(`the installed bundle declares ${String(parsed.name)}`)
    if (parsed.version !== PRODUCT_VERSION) manifestProblems.push(`the installed bundle declares ${String(parsed.version)}`)
    if (parsed.dsh?.bundle?.patch !== './cordis.patch.yml') manifestProblems.push('dsh.bundle.patch is not ./cordis.patch.yml')
    if (parsed.dsh?.bundle?.listedByDefault !== false) manifestProblems.push('dsh.bundle.listedByDefault must stay false')
    if (parsed.engines?.dsh === undefined) manifestProblems.push('the bundle declares no engines.dsh compatibility range')
    for (const [name, range] of Object.entries(parsed.dependencies ?? {})) {
      if (range.startsWith('workspace:')) manifestProblems.push(`${name} kept a workspace: range through publishing`)
    }
  }
  if (patchText === undefined) manifestProblems.push('cordis.patch.yml is absent from the installed bundle')
  check('bundle-manifest', manifestProblems.length === 0 ? undefined : manifestProblems.join('; '))

  // 5. Every patch row resolves to a package the published closure carries.
  const patchRows = patchText === undefined ? [] : patchRowsOf(patchText)
  const missingRows = patchRows
    .map(row => row.name)
    .filter((name): name is string => typeof name === 'string')
    .filter(name => !name.startsWith('@deepseek-ai/') && !resolved.has(name))
  check('patch-rows-installed', missingRows.length === 0
    ? undefined : `patch rows without a registry package: ${missingRows.join(', ')}`)

  // 6. Product peers that the hoisted install cannot resolve must be explicit dependencies,
  //    otherwise the packaged closure silently loses them.
  const missingPeers: string[] = []
  const installedHuaqiu = readdirNames(join(root, 'apps/cli/node_modules/@huaqiu'))
  for (const scopeEntry of installedHuaqiu) {
    const peerManifest = readJson(join(root, 'apps/cli/node_modules/@huaqiu', scopeEntry, 'package.json'))
    const peers = Object.keys((peerManifest.peerDependencies ?? {}) as Record<string, string>)
      .filter(name => name.startsWith('@huaqiu/'))
    for (const peer of peers) {
      if (existsSync(join(root, 'apps/cli/node_modules', peer))) continue
      if (installation.dependencies?.[peer] === undefined) missingPeers.push(`${scopeEntry} needs ${peer}`)
    }
  }
  check('product-peer-closure', missingPeers.length === 0
    ? undefined : `product peers are neither installed nor declared: ${missingPeers.join(', ')}`)

  // 7. No composed row gates activation on the HQ Edge service.
  const gated: string[] = []
  for (const name of resolved.keys()) {
    const lib = join(root, 'apps/cli/node_modules', name, 'lib')
    if (!existsSync(lib)) continue
    for (const file of readdirNames(lib)) {
      if (!file.endsWith('.js')) continue
      const body = readText(join(lib, file)) ?? ''
      if (injectedServices(body).includes('hqEdge')) gated.push(`${name}/lib/${file}`)
    }
  }
  check('no-row-injects-hq-edge', gated.length === 0 ? undefined : `rows inject hqEdge: ${gated.join(', ')}`)

  // 7. The Desktop profile selects the bundle, and the web profile keeps its upstream composition.
  const desktop = PROFILE_TEMPLATES[DESKTOP_PROFILE]?.bundles ?? []
  check('desktop-profile-selects-bundle', desktop.includes(PRODUCT_BUNDLE)
    ? undefined : `PROFILE_TEMPLATES.${DESKTOP_PROFILE} does not select ${PRODUCT_BUNDLE}`)
  const web = PROFILE_TEMPLATES.web?.bundles ?? []
  check('web-profile-unchanged', web.includes(PRODUCT_BUNDLE) ? 'the web profile must not select the product bundle' : undefined)

  // 8. The fork's sandbox default survives packaging.
  const basePatch = readText(join(root, 'packages/bundle/base/cordis.patch.yml')) ?? ''
  check('sandbox-default-preserved', basePatch.includes(`?? '${SANDBOX_DEFAULT}'`)
    ? undefined : `packages/bundle/base/cordis.patch.yml no longer defaults to ${SANDBOX_DEFAULT}`)

  // 9. Product identity is Huaqiu's, not the official distribution's.
  const product = readText(join(root, 'apps/desktop/scripts/desktop-product.mjs')) ?? ''
  const runtimeBranding = readText(join(root, 'apps/desktop/src/branding.ts')) ?? ''
  const builderConfig = readText(join(root, 'apps/desktop/scripts/electron-builder-config.mjs')) ?? ''
  const identity: string[] = []
  if (!product.includes("DESKTOP_PRODUCT_NAME = 'Huaqiu Hardware Engineering'")) identity.push('scripts/desktop-product.mjs does not name the Huaqiu product')
  if (!product.includes("DESKTOP_PROTOCOL_SCHEME = 'huaqiu'")) identity.push('scripts/desktop-product.mjs does not claim the huaqiu scheme')
  if (!runtimeBranding.includes("DESKTOP_PRODUCT_NAME = 'Huaqiu Hardware Engineering'")) identity.push('src/branding.ts disagrees with the packaging product name')
  if (!runtimeBranding.includes("DESKTOP_PROTOCOL_SCHEME = 'huaqiu'")) identity.push('src/branding.ts disagrees with the packaging URL scheme')
  if (!builderConfig.includes('productName: DESKTOP_PRODUCT_NAME')) identity.push('the installer does not take its product name from the Huaqiu identity')
  if (!builderConfig.includes('schemes: [DESKTOP_PROTOCOL_SCHEME]')) identity.push('the installer does not register the huaqiu URL scheme')
  if (!builderConfig.includes('huaqiu-hardware-engineering-')) identity.push('artifact names are not branded')
  if (/deepseek\.com|download\.deepseek/u.test(builderConfig)) identity.push('the build configuration names an official DeepSeek origin')
  check('application-identity', identity.length === 0 ? undefined : identity.join('; '))
  const officialStrings = (readText(join(root, 'apps/desktop/src/locale.ts')) ?? '').includes('DeepSeek Harness')
  check('runtime-strings-rebranded', officialStrings ? 'apps/desktop/src/locale.ts still carries "DeepSeek Harness"' : undefined)

  // 10. Nothing in the packaging scripts resolves from a product checkout.
  const siblingReferences: string[] = []
  for (const script of ['prepare-package-set.ts', 'prepare-dsh.ts', 'package-target.ts', 'pack-local-packages.ts']) {
    const body = readText(join(root, 'apps/desktop/scripts', script)) ?? ''
    if (body.includes('dsh-pcb-eda')) siblingReferences.push(script)
  }
  check('no-sibling-checkout-dependency', siblingReferences.length === 0
    ? undefined : `packaging scripts still name the product checkout: ${siblingReferences.join(', ')}`)

  // 11. Brand assets exist and are real images.
  const icons = ['icon-windows.png', 'icon-macos.png', 'icon.png', 'tray-windows.ico']
  const brokenIcons = icons.filter((name) => {
    const path = join(root, 'apps/desktop/resources', name)
    if (!existsSync(path) || statSync(path).size < 512) return true
    return name.endsWith('.png') && readFileSync(path).subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
  })
  check('brand-assets', brokenIcons.length === 0 ? undefined : `missing or malformed brand assets: ${brokenIcons.join(', ')}`)

  // 12. The welcome window's wordmark carries the Huaqiu brand, not the official one.
  const welcomeBrand = readText(join(root, 'apps/desktop/renderer/assets/welcome-brand.svg')) ?? ''
  const staleWordmark = welcomeBrand.length === 0
    ? 'apps/desktop/renderer/assets/welcome-brand.svg is missing'
    : /\bdeepseek\b|\bharness\b/iu.test(welcomeBrand.replace(/c7000b/iu, ''))
      ? 'the welcome wordmark still carries the official brand'
      : undefined
  check('welcome-wordmark-branded', welcomeBrand.includes('HUAQIU') ? staleWordmark : 'the welcome wordmark does not name Huaqiu')

  return { checks, failures: checks.flatMap(entry => entry.failure === undefined ? [] : [`${entry.id}: ${entry.failure}`]) }
}

function readdirNames(path: string): string[] {
  try { return readdirSync(path) } catch { return [] }
}

function main(): void {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  void verifyHuaqiuDesktopDistribution(root).then((result) => {
    for (const entry of result.checks) {
      console.log(`${entry.failure === undefined ? 'PASS' : 'FAIL'}  ${entry.id}${entry.failure === undefined ? '' : `: ${entry.failure}`}`)
    }
    if (result.failures.length === 0) {
      console.log(`\nHuaqiu Desktop distribution: ${String(result.checks.length)} checks pass.`)
      return
    }
    console.error(`\nHuaqiu Desktop distribution: ${String(result.failures.length)} of ${String(result.checks.length)} checks fail.`)
    process.exitCode = 1
  })
}

if (import.meta.main) main()
