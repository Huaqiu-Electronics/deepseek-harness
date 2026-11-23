/** Regression coverage for the Huaqiu Desktop distribution gate. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  injectedServices, patchRowsOf, publishedHuaqiuPackages, verifyHuaqiuDesktopDistribution,
} from './verify-huaqiu-desktop-distribution.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh.huaqiu-distribution-'))
  roots.push(root)
  return root
}

describe('injectedServices', () => {
  it('reads the service list a plugin distribution declares', () => {
    expect(injectedServices('const inject = ["tools"];')).toEqual(['tools'])
    expect(injectedServices('inject: [\'tools\', "webServer"]')).toEqual(['tools', 'webServer'])
  })

  it('reports the HQ Edge capability when a row gates on it', () => {
    expect(injectedServices('const inject = ["tools", "hqEdge"];')).toContain('hqEdge')
  })

  it('ignores lazy lookups, which M2 allows', () => {
    expect(injectedServices('const base = ctx.get("hqEdge")?.baseUrl')).toEqual([])
  })
})

describe('publishedHuaqiuPackages', () => {
  it('keeps only integrity-bearing registry entries', () => {
    const { resolved, unverified } = publishedHuaqiuPackages({
      packages: {
        "'@huaqiu/dsh-auth@0.7.10'": { resolution: { integrity: 'sha512-abc' } },
        "'@huaqiu/dsh-artifacts@0.7.10'": { resolution: { directory: 'product/huaqiu' } },
        "'lodash@4.17.21'": { resolution: { integrity: 'sha512-def' } },
      },
    })
    expect([...resolved.keys()]).toEqual(['@huaqiu/dsh-auth'])
    expect(unverified).toEqual(["'@huaqiu/dsh-artifacts@0.7.10'"])
  })

  it('ignores records that are not packages', () => {
    const { resolved, unverified } = publishedHuaqiuPackages({ snapshots: {}, importers: {} })
    expect(resolved.size).toBe(0)
    expect(unverified).toEqual([])
  })
})

describe('patchRowsOf', () => {
  it('collects nested insert rows', () => {
    const rows = patchRowsOf([
      '- id: ui-brand-official',
      '  disabled: true',
      '- insert:',
      '    - name: \'@huaqiu/dsh-auth\'',
      '    - name: \'@huaqiu/dsh-artifacts\'',
      '',
    ].join('\n'))
    expect(rows.map(row => row.name).filter(name => name !== undefined)).toEqual([
      '@huaqiu/dsh-auth', '@huaqiu/dsh-artifacts',
    ])
  })

  it('returns nothing for an empty layer', () => {
    expect(patchRowsOf('[]\n')).toEqual([])
  })
})

describe('verifyHuaqiuDesktopDistribution', () => {
  it('fails when a local artifact bridge returns to the workspace', async () => {
    const root = temp()
    mkdirSync(join(root, 'apps/cli'), { recursive: true })
    writeFileSync(join(root, 'apps/cli/package.json'), JSON.stringify({
      dependencies: { '@huaqiu/hardware-engineering': 'file:./product/huaqiu/bundle.tgz' },
    }))
    writeFileSync(join(root, 'pnpm-workspace.yaml'), [
      'overrides:',
      "  '@huaqiu/hardware-engineering': 'file:./product/huaqiu/huaqiu-hardware-engineering-0.7.10.tgz'",
      '',
    ].join('\n'))
    const result = await verifyHuaqiuDesktopDistribution(root)
    expect(result.failures.some(failure => failure.startsWith('installation-declares-bundle:'))).toBe(true)
    expect(result.failures.some(failure => failure.startsWith('no-local-package-bridge:'))).toBe(true)
  })

  it('reports a missing registry resolution instead of throwing', async () => {
    const root = temp()
    mkdirSync(join(root, 'apps/cli'), { recursive: true })
    writeFileSync(join(root, 'apps/cli/package.json'), JSON.stringify({
      dependencies: { '@huaqiu/hardware-engineering': '0.7.10' },
    }))
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'packages: {}\n')
    const result = await verifyHuaqiuDesktopDistribution(root)
    expect(result.failures.some(failure => failure.startsWith('registry-resolution:'))).toBe(true)
    expect(result.failures.some(failure => failure.startsWith('bundle-manifest:'))).toBe(true)
  })

  it('catches a product peer that neither installs nor is declared', async () => {
    const root = temp()
    const installed = join(root, 'apps/cli/node_modules/@huaqiu/dsh-tool-symbol-footprint')
    mkdirSync(installed, { recursive: true })
    writeFileSync(join(installed, 'package.json'), JSON.stringify({
      name: '@huaqiu/dsh-tool-symbol-footprint',
      peerDependencies: { '@huaqiu/component-gen-app': '^0.7.10' },
    }))
    writeFileSync(join(root, 'apps/cli/package.json'), JSON.stringify({
      dependencies: { '@huaqiu/hardware-engineering': '0.7.10' },
    }))
    const undeclared = await verifyHuaqiuDesktopDistribution(root)
    expect(undeclared.failures.some(failure => failure.startsWith('product-peer-closure:'))).toBe(true)

    writeFileSync(join(root, 'apps/cli/package.json'), JSON.stringify({
      dependencies: {
        '@huaqiu/component-gen-app': '0.7.10',
        '@huaqiu/hardware-engineering': '0.7.10',
      },
    }))
    const declared = await verifyHuaqiuDesktopDistribution(root)
    expect(declared.failures.some(failure => failure.startsWith('product-peer-closure:'))).toBe(false)
  })
})
