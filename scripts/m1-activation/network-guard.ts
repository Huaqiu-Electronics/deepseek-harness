/**
 * Block and record outbound TCP during an activation run.
 *
 * "Activation works without network access" is only meaningful as an executed
 * observation: the process must be *unable* to reach a registry and still
 * activate. Every socket connect funnels through `net.Socket.prototype.connect`
 * — `net.connect`, `tls.connect`, and the `http`/`https`/`fetch` stacks all end
 * up there — so one patch covers the whole egress surface. Loopback stays open
 * because the profile's own web server binds and probes it.
 */
import { Socket } from 'node:net'

/** One attempted connection, recorded whether or not it was allowed. */
export interface NetworkAttempt {
  readonly host: string
  readonly port: number | undefined
  readonly allowed: boolean
}

/** The installed guard. */
export interface NetworkGuard {
  /** Attempts in the order they were made. */
  readonly attempts: NetworkAttempt[]
  /** Put the original `connect` back. */
  restore(): void
}

/**
 * Whether a host names the local machine.
 * @param host - a host name, IPv4/IPv6 literal, or unix socket path.
 * @returns true when connecting to it cannot leave the machine.
 */
function isLoopback(host: string): boolean {
  // A unix socket path never touches a network stack.
  if (host.startsWith('/')) return true
  if (host === 'localhost' || host === '::1' || host === '[::1]' || host === 'ip6-localhost') return true
  const v4 = host.startsWith('::ffff:') ? host.slice('::ffff:'.length) : host
  if (/^127\./u.test(v4)) return true
  return v4 === '::' || v4 === '0.0.0.0'
}

/** Options for {@link installNetworkGuard}. */
export interface NetworkGuardOptions {
  /** Reject non-loopback connects. False records them and lets them proceed. */
  block?: boolean
}

/**
 * Install the guard on the current process.
 * @param options - whether to reject non-loopback connects.
 * @returns the guard; call `restore()` when the run is over.
 */
export function installNetworkGuard(options: NetworkGuardOptions = {}): NetworkGuard {
  const attempts: NetworkAttempt[] = []
  const original = Socket.prototype.connect
  const patched = function patchedConnect(this: Socket, ...args: unknown[]): Socket {
    const [first, second] = args
    let host: string | undefined
    let port: number | undefined
    if (typeof first === 'object' && first !== null) {
      const options = first as { host?: string; port?: number; path?: string }
      // `path` (unix socket) takes precedence over `host` in net's own parsing.
      host = options.path ?? options.host
      port = options.port
    } else if (typeof first === 'number') {
      port = first
      host = typeof second === 'string' ? second : undefined
    } else if (typeof first === 'string') {
      host = first
    }
    // net treats an omitted host as the local machine.
    const target = host ?? '127.0.0.1'
    const allowed = isLoopback(target)
    attempts.push({ host: target, port, allowed })
    if (!allowed && options.block !== false) {
      throw new Error(
        `m1-activation: blocked outbound connection to ${target}${port === undefined ? '' : `:${port}`} — `
        + 'activation must not require network access',
      )
    }
    return Reflect.apply(original, this, args) as Socket
  }
  Socket.prototype.connect = patched as typeof Socket.prototype.connect
  return {
    attempts,
    restore: () => { Socket.prototype.connect = original },
  }
}
