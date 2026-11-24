/**
 * The guide tab's identity, the page-address scheme, and default page selection.
 *
 * These live in the contract because two sides need them and neither may read
 * the other: the store seeds new panes from the registry, and the guide
 * domain registers the type under the same kind.
 *
 * The docking kit treats `kind` as opaque, so these strings mean something only
 * here and in the registry. Both types go through the same two stages any other
 * type would use — the guide is not special in the machinery, only in being
 * always available.
 */
import type { SidebarRightTabRegistry } from '../tab-registry.ts'

/** One pane's initial page, resolved from the current registered guide entries. */
export interface SidebarRightSeed {
  readonly kind: string
  readonly title: string
}

/**
 * Resolve the default page.
 *
 * A type may declare itself the product's default page (`default: true` in its
 * definition); the panel seeds that kind into a fresh docked pane, which is what
 * makes an expansion show the product's own page instead of a general one. A
 * product that declares no default keeps the older rule: the registry's sole
 * guide entry, else the guide.
 * @param tabs - current tab registry.
 * @returns the declared default page, else the sole guide entry, else the guide.
 */
export function defaultSeed(tabs: SidebarRightTabRegistry): SidebarRightSeed {
  const declared = tabs.entries().filter(definition => definition.default === true)
  if (declared.length > 1) {
    throw new Error(`sidebarRight: ${String(declared.length)} tab types declare themselves the default page`)
  }
  const preferred = declared[0]
  if (preferred !== undefined) return { kind: preferred.kind, title: preferred.title(pageAddress(preferred.kind)) }
  const [only, ...others] = tabs.guide()
  const single = only !== undefined && others.length === 0
  const kind = single ? only.kind : GUIDE_KIND
  const definition = tabs.get(kind)
  if (definition === undefined) throw new Error(`sidebarRight: default tab kind "${kind}" is not registered`)
  return { kind, title: definition.title(pageAddress(kind)) }
}

/** The guide tab's kind. */
export const GUIDE_KIND = 'guide'

/**
 * The address a page tab is recorded under: `sidebar://<kind>`. The scheme is
 * this package's bookkeeping for `openTab`, spelled here and nowhere else; a
 * caller names the kind and never sees or composes the address.
 * @param kind - the page type's kind.
 * @returns the page's address.
 */
export function pageAddress(kind: string): string {
  return `sidebar://${kind}`
}
