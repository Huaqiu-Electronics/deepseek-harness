/**
 * The Desktop product composition: which bundles a Desktop profile stacks, and
 * the sandbox default those layers resolve to.
 *
 * Composition-level on purpose. It loads the real profile (`loadProfile`, the
 * entry point both the CLI and the Desktop Host use) and composes the real patch
 * layers (`composeEntries`), so it fails if the product bundle is dropped from
 * the template, if a layer stops resolving, or if the Huaqiu sandbox default
 * stops winning the merge — failures that otherwise surface only as a
 * normal-looking window with missing features.
 *
 * `!!js` config values are not evaluated at load time (the loader resolves them
 * when it mounts the row), so {@link jsValue} evaluates them here with an
 * explicit `process.env` to assert the default *and* that the environment can
 * still override it.
 *
 * Plugin activation is not covered here; that is the M1 activation fixture.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { composeEntries, loadProfile } from '@deepseek-ai/dsh-app-boot'
import { INSTALLATION_OWNED_PROFILE_TUPLES, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-official-bundles'

/** apps/cli/package.json — the anchor the CLI and the Desktop Host boot from. */
const INSTALL_ANCHOR = fileURLToPath(new URL('../../cli/package.json', import.meta.url))
const PRODUCT_BUNDLE = '@huaqiu/hardware-engineering'
const DESKTOP = PROFILE_TEMPLATES.desktop!.bundles

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function profileWith(bundles: readonly string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-product-profile-'))
  roots.push(home)
  const dir = join(home, 'profiles', 'desktop')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    private: true,
    dependencies: Object.fromEntries(bundles.map(name => [name, '0.0.0'])),
    dsh: { profile: { bundles: [...bundles] } },
  }, undefined, 2)}\n`)
  return home
}

interface ComposedRow {
  id?: string
  name?: string
  config?: unknown
  disabled?: boolean
}

function composed(home: string, name = 'desktop'): ComposedRow[] {
  const profile = loadProfile('dsh-desktop-test', name, INSTALL_ANCHOR, home)
  expect(profile.skippedBundles, `skipped: ${JSON.stringify(profile.skippedBundles)}`).toEqual([])
  return composeEntries(profile.layers.map(layer => layer.patches)) as ComposedRow[]
}

/**
 * Evaluate one `!!js` config value from a composed row under a given environment,
 * the way the loader does when it mounts the entry.
 */
function jsValue(rows: ComposedRow[], id: string, key: string, env: Record<string, string | undefined> = {}): unknown {
  const row = rows.find(candidate => candidate.id === id)
  expect(row, `missing row ${id}`).toBeDefined()
  const raw = (row!.config as Record<string, unknown>)[key]
  if (typeof raw !== 'object' || raw === null) return raw
  const expression = (raw as { __jsExpr?: unknown }).__jsExpr
  expect(typeof expression, `${id}.${key} is not a literal or a !!js expression`).toBe('string')
  // Same shape the loader uses: the expression is evaluated with a `process` in scope.
  return (new Function('process', `return (${String(expression)})`) as (p: unknown) => unknown)({ env })
}

describe('Desktop product profile composition', () => {
  it('stacks base, web-app and the Hardware Engineering bundle, and nothing else', () => {
    const profile = loadProfile('dsh-desktop-test', 'desktop', INSTALL_ANCHOR, profileWith(DESKTOP))
    expect(profile.skippedBundles).toEqual([])
    expect(profile.layers.map(layer => layer.packageName)).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      PRODUCT_BUNDLE,
    ])
  })

  it('mounts the product plugins the bundle patch inserts', () => {
    const ids = new Set(composed(profileWith(DESKTOP)).map(row => row.id))
    for (const id of [
      'huaqiu-auth',
      'huaqiu-artifacts',
      'huaqiu-dsh-kicad',
      'dsh-tool-kicad-schematic-gen',
      'dsh-tool-pcb-viewer',
      'huaqiu-tool-part-search',
      'huaqiu-eda-selection',
      'huaqiu-tool-quote',
      'huaqiu-tool-symbol-footprint',
      'ui-theme-huaqiu',
      'dsh-huaqiu-about',
    ]) {
      expect(ids, `missing loader row ${id}`).toContain(id)
    }
  })

  it('replaces the official brand row with the bundled theme', () => {
    const rows = composed(profileWith(DESKTOP))
    expect(rows.find(row => row.id === 'ui-brand-official')?.disabled).toBe(true)
  })

  it('keeps the CLI/upstream web profile free of the product bundle', () => {
    const rows = composed(profileWith(PROFILE_TEMPLATES.web!.bundles), 'web')
    expect(rows.some(row => row.id?.startsWith('huaqiu-'))).toBe(false)
    expect(rows.some(row => row.id?.startsWith('dsh-tool-pcb-viewer'))).toBe(false)
    expect(rows.some(row => row.id === 'ui-brand-official' && row.disabled === true)).toBe(false)
  })

  it('resolves the Full access sandbox default the Huaqiu product requires', () => {
    const rows = composed(profileWith(DESKTOP))
    expect(jsValue(rows, 'sandbox-policy', 'mode')).toBe('danger-full-access')
    expect(jsValue(rows, 'approval', 'policy')).toBe('never')
  })

  it('still lets the environment override the sandbox default', () => {
    // The product default must not become a lock: a deployment that pins a
    // confining mode keeps it, and the approval policy follows it.
    const rows = composed(profileWith(DESKTOP))
    expect(jsValue(rows, 'sandbox-policy', 'mode', { DSH_PERMISSION_MODE: 'workspace-write' })).toBe('workspace-write')
    expect(jsValue(rows, 'approval', 'policy', { DSH_PERMISSION_MODE: 'workspace-write' })).toBe('ask')
  })
})

describe('legacy Desktop profile upgrade', () => {
  it('recognizes the pre-product tuple as installation-owned', () => {
    // If these two disagree, an existing Desktop install never picks up the
    // product bundle on upgrade: the loader leaves any other list untouched.
    expect(INSTALLATION_OWNED_PROFILE_TUPLES.desktop).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
    ])
    expect(DESKTOP).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      PRODUCT_BUNDLE,
    ])
  })

  it('upgrades a profile still carrying the legacy tuple in place', () => {
    const home = profileWith(INSTALLATION_OWNED_PROFILE_TUPLES.desktop!)
    const profile = loadProfile('dsh-desktop-test', 'desktop', INSTALL_ANCHOR, home)
    expect(profile.layers.map(layer => layer.packageName)).toEqual(DESKTOP)
    // The upgrade is written back, so the next boot does not repeat it.
    const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'desktop', 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dsh.profile.bundles).toEqual(DESKTOP)
  })

  it('leaves a customized profile list alone rather than guessing', () => {
    const custom = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-sdk-app']
    const profile = loadProfile('dsh-desktop-test', 'desktop', INSTALL_ANCHOR, profileWith(custom))
    // Not an exact installation-owned tuple: the loader must not rewrite it.
    expect(profile.layers.map(layer => layer.packageName)).toEqual(custom)
  })
})
