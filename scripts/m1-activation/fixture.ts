/**
 * Build a throwaway DSH *installation* that contains the packed Huaqiu product
 * bundle, so activation can be proven against the artifact a user receives
 * instead of against workspace source.
 *
 * The layout mirrors a real installation closely enough for the resolution
 * rules that matter:
 *
 *   <root>/installation/apps/cli/package.json     ← the install anchor
 *   <root>/installation/node_modules/@huaqiu/*    ← extracted product tarballs
 *   <root>/installation/node_modules/@deepseek-ai ← link to this workspace
 *   <root>/home/profiles/<name>/                  ← a clean profile directory
 *
 * Only the packages the product bundle *declares* are extracted: the closure is
 * computed from the packed manifests, so a dependency the bundle forgot to
 * declare shows up as a resolution failure at boot rather than being masked by
 * a sibling package that happened to be lying around.
 */
import { execFileSync } from 'node:child_process'
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { initProfile } from '@deepseek-ai/dsh-app-boot'

/** The product bundle whose declared closure populates the fixture. */
export const PRODUCT_BUNDLE = '@huaqiu/hardware-engineering'

/** Options for {@link buildInstallationFixture}. */
export interface FixtureOptions {
  /** Directory holding the `pnpm pack` output. */
  distDir: string
  /** Root of the deepseek-harness workspace (the source of the `@deepseek-ai` scope). */
  harnessRoot: string
  /** Product version to unpack; every tarball must be this exact version. */
  version: string
  /** `dsh.profile.bundles` for the fixture profile, in application order. */
  bundles: readonly string[]
  /** Profile directory name under `<home>/profiles`. */
  profileName: string
  /** Keep the fixture after the run; the caller reports the path. */
  keep?: boolean
}

/** One package the fixture installed from a tarball. */
export interface InstalledPackage {
  readonly name: string
  readonly version: string
  readonly directory: string
  readonly tarball: string
}

/** One member of a product bundle's declared `@huaqiu/*` dependency closure. */
export interface ClosureEntry {
  readonly name: string
  /** `packed` = a workspace package this run produced; `published` = already on npm. */
  readonly kind: 'packed' | 'published'
  readonly version: string
  /** Source directory for a published package; undefined for a packed one. */
  readonly directory: string | undefined
  readonly tarball: string | undefined
  readonly dependencies: readonly string[]
}

/** A built fixture, ready to boot. */
export interface InstallationFixture {
  readonly root: string
  readonly installationDir: string
  /** Absolute path of the app package manifest, i.e. the installation anchor. */
  readonly installAnchor: string
  /** Absolute path of the isolated DSH home (`DSH_HOME`). */
  readonly home: string
  readonly profileDir: string
  readonly profileName: string
  readonly packages: readonly InstalledPackage[]
  /** Every `@huaqiu/*` package the product bundle declares, packed or published. */
  readonly closure: readonly ClosureEntry[]
}

interface Manifest {
  name?: string
  version?: string
  dependencies?: Record<string, string>
}

/** Tarball file name pnpm produces for a scoped package. */
function tarballName(packageName: string, version: string): string {
  return `${packageName.replace(/^@/u, '').replace(/\//gu, '-')}-${version}.tgz`
}

/**
 * Extract one tarball into `<nodeModules>/<package name>`, the flat layout a
 * real install produces for both scoped and unscoped names.
 * @param tarball - absolute path of the `.tgz`.
 * @param nodeModules - the fixture's `node_modules` directory.
 * @param scratch - a temp directory used for the intermediate extraction.
 * @returns the installed package's name, version, and directory.
 */
function extractTarball(tarball: string, nodeModules: string, scratch: string): InstalledPackage {
  const staging = join(scratch, basename(tarball, '.tgz'))
  mkdirSync(staging, { recursive: true })
  execFileSync('tar', ['-xzf', tarball, '-C', staging], { stdio: 'pipe' })
  const unpacked = join(staging, 'package')
  const manifest = JSON.parse(readFileSync(join(unpacked, 'package.json'), 'utf8')) as Manifest
  if (manifest.name === undefined || manifest.version === undefined) {
    throw new Error(`m1-activation: ${tarball} has no name/version in its manifest`)
  }
  const directory = join(nodeModules, ...manifest.name.split('/'))
  mkdirSync(dirname(directory), { recursive: true })
  cpSync(unpacked, directory, { recursive: true })
  return { name: manifest.name, version: manifest.version, directory, tarball }
}

/**
 * Walk the packed manifests' `dependencies` and return every `@huaqiu/*`
 * package reachable from `root`, breadth-first.
 *
 * `@deepseek-ai/*` names are deliberately not followed: those are the host and
 * come from the installation's own scope, exactly as they would in a user's
 * install. A `@huaqiu/*` name is either
 *
 * - a workspace package, which MUST have a tarball — its absence means a
 *   declared dependency was never packed, and
 * - an already-published package (e.g. `@huaqiu/part-search`), which a real
 *   install fetches once at install time; the fixture symlinks the copy the
 *   workspace already resolved so activation still runs offline.
 *
 * @param distDir - directory holding the tarballs.
 * @param version - required exact version of every packed package.
 * @param root - the product bundle to start from.
 * @param publishedRoots - directories whose `node_modules` may hold a published `@huaqiu/*`.
 * @returns the closure in discovery order, with `root` first.
 * @throws when a `@huaqiu/*` dependency is neither packed nor installed anywhere.
 */
export function declaredClosure(
  distDir: string,
  version: string,
  root: string,
  publishedRoots: readonly string[] = [],
): ClosureEntry[] {
  const order: ClosureEntry[] = []
  const seen = new Set<string>()
  const queue = [root]
  while (queue.length > 0) {
    const name = queue.shift() as string
    if (seen.has(name)) continue
    seen.add(name)
    const tarball = join(distDir, tarballName(name, version))
    let entry: ClosureEntry
    if (existsSync(tarball)) {
      const manifest = JSON.parse(
        execFileSync('tar', ['-xzf', tarball, '-xO', 'package/package.json'], { encoding: 'utf8' }),
      ) as Manifest
      entry = {
        name,
        kind: 'packed',
        version: manifest.version ?? version,
        directory: undefined,
        tarball,
        dependencies: Object.keys(manifest.dependencies ?? {}),
      }
    } else {
      const directory = publishedRoots
        .map(base => join(base, 'node_modules', ...name.split('/')))
        .find(candidate => existsSync(join(candidate, 'package.json')))
      if (directory === undefined) {
        throw new Error(
          `m1-activation: ${name} is neither packed at ${version} (${tarball}) nor installed under `
          + `[${publishedRoots.join(', ')}]; it is a declared dependency with no artifact`,
        )
      }
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as Manifest
      entry = {
        name,
        kind: 'published',
        version: manifest.version ?? 'unknown',
        directory,
        tarball: undefined,
        dependencies: Object.keys(manifest.dependencies ?? {}),
      }
    }
    order.push(entry)
    for (const dependency of entry.dependencies) {
      // Only @huaqiu/* participates in this closure; the host supplies the rest.
      if (dependency.startsWith('@huaqiu/')) queue.push(dependency)
    }
  }
  return order
}

/**
 * Build the installation fixture on disk.
 * @param options - dist directory, workspace root, version, and profile shape.
 * @returns the fixture description, including every installed package.
 * @throws when a declared dependency has no tarball or a tarball has the wrong version.
 */
export function buildInstallationFixture(options: FixtureOptions): InstallationFixture {
  const harnessRoot = resolve(options.harnessRoot)
  const distDir = resolve(options.distDir)
  const root = mkdtempSync(join(tmpdir(), 'dsh-m1-activation-'))
  const installationDir = join(root, 'installation')
  const nodeModules = join(installationDir, 'node_modules')
  const home = join(root, 'home')
  mkdirSync(nodeModules, { recursive: true })

  // The installation's own dependency scope: one link, so every @deepseek-ai
  // peer resolves to the same instance the host loaded (a duplicate copy would
  // give a second `cordis` and silently break service identity).
  const scope = join(harnessRoot, 'apps/cli/node_modules/@deepseek-ai')
  if (!existsSync(scope)) {
    throw new Error(`m1-activation: ${scope} is missing; run 'pnpm install' in ${harnessRoot} first`)
  }
  symlinkSync(scope, join(nodeModules, '@deepseek-ai'), 'dir')

  // Published @huaqiu/* packages are resolved from the product workspace, which
  // already installed them; the tarball directory's parent is that workspace.
  const productRoot = dirname(distDir)
  const publishedRoots = [
    productRoot,
    ...readdirSync(join(productRoot, 'packages'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(productRoot, 'packages', entry.name)),
  ]
  const closure = declaredClosure(distDir, options.version, PRODUCT_BUNDLE, publishedRoots)
  const scratch = join(root, 'scratch')
  mkdirSync(scratch, { recursive: true })
  const packages: InstalledPackage[] = []
  for (const entry of closure) {
    const target = join(nodeModules, ...entry.name.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    if (entry.kind === 'packed') {
      const installed = extractTarball(entry.tarball as string, nodeModules, scratch)
      if (installed.version !== options.version) {
        throw new Error(
          `m1-activation: ${installed.name} unpacked at ${installed.version}, expected ${options.version}`,
        )
      }
      packages.push(installed)
    } else {
      // A published dependency resolves through its own store directory so its
      // siblings stay visible; activation itself still performs no network I/O.
      symlinkSync(entry.directory as string, target, 'dir')
    }
  }
  rmSync(scratch, { recursive: true, force: true })

  // Third-party dependencies (`kicad-sexpr-parser`, `sharp`, …) are what a real
  // `npm install` would fetch. The fixture links the copy the product workspace
  // already resolved, so a plugin whose package.json omits one of them still
  // fails here for the right reason — it is absent from the declaration, not
  // merely absent from disk.
  const linked = new Set<string>()
  for (const entry of closure) {
    for (const dependency of entry.dependencies) {
      if (dependency.startsWith('@huaqiu/') || dependency.startsWith('@deepseek-ai/')) continue
      if (linked.has(dependency)) continue
      linked.add(dependency)
      const source = publishedRoots
        .map(base => join(base, 'node_modules', ...dependency.split('/')))
        .find(candidate => existsSync(join(candidate, 'package.json')))
      if (source === undefined) {
        throw new Error(
          `m1-activation: ${entry.name} declares ${dependency}, which is not installed anywhere under `
          + `${productRoot}; run 'pnpm install' in ${productRoot} first`,
        )
      }
      const target = join(nodeModules, ...dependency.split('/'))
      mkdirSync(dirname(target), { recursive: true })
      if (!existsSync(target)) symlinkSync(source, target, 'dir')
    }
  }

  // The app package that owns the installation. `resolveBundleDir` starts its
  // `createRequire().resolve.paths` walk here, so this file's directory decides
  // which `node_modules` the product bundle is found in.
  const appDir = join(installationDir, 'apps/cli')
  mkdirSync(appDir, { recursive: true })
  writeFileSync(join(appDir, 'package.json'), `${JSON.stringify({
    name: '@deepseek-ai/dsh',
    version: options.version,
    private: true,
    dependencies: {
      ['@deepseek-ai/dsh-base']: '*',
      ['@deepseek-ai/dsh-web-app']: '*',
      [PRODUCT_BUNDLE]: options.version,
    },
  }, undefined, 2)}\n`)

  const profileDir = join(home, 'profiles', options.profileName)
  mkdirSync(profileDir, { recursive: true })
  initProfile(profileDir, options.bundles)

  return {
    root,
    installationDir,
    installAnchor: join(appDir, 'package.json'),
    home,
    profileDir,
    profileName: options.profileName,
    packages,
    closure,
  }
}

/**
 * Delete a fixture unless the caller asked to keep it.
 * @param fixture - the fixture to remove.
 */
export function discardFixture(fixture: InstallationFixture): void {
  rmSync(fixture.root, { recursive: true, force: true })
}
