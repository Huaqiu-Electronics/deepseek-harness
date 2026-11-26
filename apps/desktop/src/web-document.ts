/** Local Web document and authenticated HTTP forwarding for the application window. */
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { DESKTOP_PRODUCT_NAME } from './branding.ts'

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon',
}
const BOOT = '<script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()</script>'

/** Huaqiu's application mark, served in place of the upstream Web favicon. */
const HUAQIU_FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="192" fill="#FFFFFF"/>
  <rect x="8" y="8" width="1008" height="1008" rx="184" stroke="#E9E4E2" stroke-width="4"/>
  <g transform="translate(230 230) scale(0.578)" fill="#C7000B" fill-rule="evenodd">
    <path d="M865.67,758.67a107,107,0,1,0,107,107A107,107,0,0,0,865.67,758.67Z"/>
    <path d="M744.11,0h-514C103.56,0,0,103.56,0,230.14v514C0,870.69,103.56,974.25,230.14,974.25h514c3.34,0,6.66-.06,10-.21a155.66,155.66,0,0,1-40-143.56H230.14a86.63,86.63,0,0,1-86.37-86.37v-514a86.63,86.63,0,0,1,86.37-86.37h514a86.61,86.61,0,0,1,86.37,86.37V714.06a156.93,156.93,0,0,1,35.19-4A155.1,155.1,0,0,1,974,754c.15-3.28.21-6.6.21-9.92v-514C974.25,103.56,870.69,0,744.11,0Z"/>
    <polygon points="735.67 735.65 735.67 238.59 591.9 238.59 591.9 415.24 382.39 415.24 382.39 238.59 238.62 238.59 238.62 735.65 382.39 735.65 382.39 559.01 591.9 559.01 591.9 735.65 735.67 735.65"/>
  </g>
</svg>`

/** Identity the Desktop shell gives the upstream Web entry while it boots. */
export interface WebDocumentBranding {
  readonly title: string
  readonly shortName: string
}

/** Desktop's override for the upstream Web entry's title, install metadata, and tab icon. */
export const HUAQIU_WEB_BRANDING: WebDocumentBranding = {
  title: DESKTOP_PRODUCT_NAME,
  shortName: 'Huaqiu',
}

function brandedIndex(html: string, branding: WebDocumentBranding): string {
  return html
    .replace(/<title>[\s\S]*?<\/title>/iu, `<title>${branding.title}</title>`)
    .replace(/<meta\s+name="apple-mobile-web-app-title"\s+content="[^"]*"/iu,
      `<meta name="apple-mobile-web-app-title" content="${branding.shortName}"`)
    .replace(/href="(?:\.\/|\/)?favicon(?:-dark)?\.svg"/giu, 'href="/favicon.svg"')
    .replace(/<link\s+rel="apple-touch-icon"[^>]*>/iu, '')
}

function brandManifest(branding: WebDocumentBranding): string {
  return JSON.stringify({
    name: branding.title,
    short_name: branding.shortName,
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  })
}

/**
 * Read an application-owned static asset; the index waits for asynchronous Host injections.
 * A branding override replaces only the upstream entry's identity metadata and icon;
 * the shell's own renderer documents are served unchanged.
 * @param request - Local application request.
 * @param root - Packaged Web dist directory.
 * @param branding - Optional distribution identity for the Web entry.
 * @returns Static response, or a missing/invalid path response.
 */
export async function serveWebDocument(request: Request, root: string, branding?: WebDocumentBranding): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 })
  const url = new URL(request.url)
  let pathname: string
  try { pathname = decodeURIComponent(url.pathname) } catch { return new Response(null, { status: 400 }) }

  if (branding !== undefined && ['/favicon.svg', '/favicon-dark.svg'].includes(pathname)) {
    return new Response(request.method === 'HEAD' ? null : HUAQIU_FAVICON,
      { headers: { 'content-type': MIME['.svg'] ?? 'image/svg+xml' } })
  }
  if (branding !== undefined && pathname === '/manifest.webmanifest') {
    return new Response(request.method === 'HEAD' ? null : brandManifest(branding),
      { headers: { 'content-type': 'application/manifest+json' } })
  }

  const target = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname))
  const directory = resolve(root)
  if (!target.startsWith(directory + sep)) return new Response(null, { status: 403 })
  let body: Buffer
  try { body = await readFile(target) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Response(null, { status: 404 })
    throw error
  }
  const isIndex = pathname === '/' || pathname === '/index.html'
  let content: string | Uint8Array = new Uint8Array(body)
  if (isIndex) {
    const html = body.toString().replace('<head>', '<head>' + BOOT)
    content = branding === undefined ? html : brandedIndex(html, branding)
  }
  const payload = request.method === 'HEAD' ? null : new Blob([content as BlobPart])
  return new Response(payload, {
    headers: { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' },
  })
}

/**
 * Exchange the Host launch URL for an authority-bound browser cookie.
 * @param url - Authenticated URL reported by the owned Host process.
 * @returns Cookie header for requests forwarded to that Host.
 */
export async function authenticateWebHost(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'manual' })
  const cookie = response.headers.get('set-cookie')
  await response.body?.cancel()
  if (response.status !== 303 || cookie === null) throw new Error('Desktop Host authentication failed')
  const end = cookie.indexOf(';')
  return end < 0 ? cookie : cookie.slice(0, end)
}

/** Cookie store operations used to remove legacy Host authentication cookies. */
export interface HostCookieStore {
  get(filter: { url: string }): Promise<readonly { readonly name: string }[]>
  remove(url: string, name: string): Promise<void>
}

/**
 * Remove every `dsh-auth-*` cookie that earlier releases left in a cookie store for the Host's hostname.
 * Cookies ignore ports, so cookies from earlier random-port Hosts would otherwise travel with every
 * request to that hostname until they expire.
 * @param cookies - Electron session cookie store.
 * @param url - Host URL; cookies for its hostname on every port are removed.
 */
export async function removeLegacyHostCookies(cookies: HostCookieStore, url: string): Promise<void> {
  const origin = new URL(url).origin
  for (const { name } of await cookies.get({ url: origin })) {
    if (name.startsWith('dsh-auth-')) await cookies.remove(origin, name)
  }
}

/**
 * Response headers not relayed to the renderer. `set-cookie` would hand the
 * Host's authentication cookie to the page's cookie jar, which the shell owns
 * instead; the rest describe the Node `fetch` connection (its encoding, length,
 * and hop-by-hop transport), which Chromium never sees.
 */
const WITHHELD_RESPONSE_HEADERS = [
  'set-cookie',
  'content-encoding', 'content-length',
  'transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-authorization',
]

/** Host routes whose responses carry immutable cache headers keyed by a per-process revision. */
const PLUGIN_BUNDLE_PATH = /^\/plugins\//u

/**
 * Forward local application requests to its authenticated Host, preserving streaming and cancellation.
 * Plugin bundle responses lose their `cache-control` for `no-store`: the Host marks them immutable
 * under a revision that changes every launch, so Chromium's disk cache would only accumulate bundles
 * no later launch can reuse.
 * @param request - Request from the application origin.
 * @param host - Owned Host URL.
 * @param cookie - Host-issued authentication cookie.
 * @returns Host response without connection-level headers.
 */
export async function forwardWebRequest(request: Request, host: string, cookie: string): Promise<Response> {
  const source = new URL(request.url)
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== 'dsh-app://app') return new Response(null, { status: 403 })
  const target = new URL(host)
  target.pathname = source.pathname
  target.search = source.search
  const headers = new Headers(request.headers)
  for (const name of ['host', 'origin', 'cookie', 'sec-fetch-site']) headers.delete(name)
  headers.set('cookie', cookie)
  const init = { method: request.method, headers, body: request.body, signal: request.signal, duplex: 'half', redirect: 'manual' as const }
  const response = await fetch(target, init)
  const outgoing = new Headers(response.headers)
  for (const name of WITHHELD_RESPONSE_HEADERS) outgoing.delete(name)
  if (PLUGIN_BUNDLE_PATH.test(source.pathname)) outgoing.set('cache-control', 'no-store')
  return new Response(response.body, { status: response.status, headers: outgoing })
}
