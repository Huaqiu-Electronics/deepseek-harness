/** The one plugin workflow the Windows caption menu can start, and nothing more. */

/**
 * A plugin installs this while it is active. The shell deliberately knows no
 * project, order type or hqpcb URL: it only asks the plugin to start its own
 * workflow (PO-02).
 *
 * The registration cannot travel through a bare `window` property: Desktop
 * windows run with `contextIsolation: true` and `sandbox: true`, so a global the
 * page sets is invisible to this preload. `contextBridge` proxies the callback
 * across that boundary instead, which is why this registry lives in preload
 * scope and is exposed through `dshDesktop.registerPlaceOrder`.
 */
type PlaceOrderHandler = () => boolean

const handlers = new Set<PlaceOrderHandler>()

/**
 * Register the active Place Order workflow.
 * @param handler - starts the plugin's own workflow; `false` when it could not.
 * @returns withdrawal of this registration, called when the plugin unloads.
 */
export function registerPlaceOrderHandler(handler: PlaceOrderHandler): () => void {
  handlers.add(handler)
  return () => { handlers.delete(handler) }
}

/**
 * Start the registered workflow once.
 * @returns whether a handler accepted the request; `false` means no plugin is
 * loaded, so the menu can explain that instead of doing nothing. A handler that
 * throws propagates to the menu's failure copy.
 */
export function runPlaceOrderHandler(): boolean {
  for (const handler of handlers) {
    if (handler()) return true
  }
  return false
}
