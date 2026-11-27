/** Windows caption menu labels and native popup anchors, isolated from the Web client. */
import { ipcRenderer } from 'electron'
import { DESKTOP_IPC } from './ipc.ts'
import { resolveDesktopLocale } from './locale.ts'

/**
 * The one thing the shell asks the Huaqiu plugin for (PO-02).
 *
 * Deliberately a handle rather than a URL, an IPC channel or a menu-extension
 * framework: the plugin installs `window.huaqiu` while it is active, so the
 * caption menu can start the workflow without knowing a single project, order
 * type or hqpcb URL. When the plugin is absent the handle is absent and the
 * menu says so instead of doing nothing.
 */
interface PlaceOrderHandle {
  placeOrder?: () => boolean
}

function placeOrderHandle(): PlaceOrderHandle | undefined {
  return (window as unknown as { huaqiu?: PlaceOrderHandle }).huaqiu
}

/** Cart glyph, drawn once at 14px like the app's other menu icons. */
const CART_ICON = `
<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/>
  <path d="M2.5 3.5h3l2.6 12.2a1.6 1.6 0 0 0 1.6 1.3h9.4a1.6 1.6 0 0 0 1.6-1.3L22 8H6.4"/>
</svg>`

/**
 * Mount the Windows caption menubar without moving focus out of the active editor.
 * @returns Language refresh and document teardown operations.
 */
export function installWindowsMenu(): { update(): void; dispose(): void } {
  const host = document.createElement('div')
  host.dataset.windowsMenu = ''
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = `
    :host { position: fixed; top: 0; left: var(--dsh-windows-menu-start, 48px); z-index: 1100;
      height: var(--dsh-windows-titlebar-height); display: flex; align-items: center;
      font-family: var(--dsw-font-family); -webkit-app-region: no-drag; }
    [role=menubar] { display: flex; gap: 2px; }
    button { height: 28px; padding: 0 10px; border: 0; border-radius: 6px;
      background: transparent; color: var(--dsw-alias-label-secondary);
      font: inherit; font-size: 14px; cursor: default; }
    button:hover, button[aria-expanded=true] { background: var(--dsw-alias-interactive-bg-hover);
      color: var(--dsw-alias-label-primary); }
    button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: -2px; }
    :host-context(html[data-input-modality='pointer']) button:focus-visible { outline-color: transparent; }
    button[data-place-order] { display: flex; align-items: center; gap: 6px; }
    button[data-place-order] svg { opacity: .9; }
    [data-menu-notice] { position: fixed; top: calc(var(--dsh-windows-titlebar-height) + 4px);
      left: var(--dsh-windows-menu-start, 48px); max-width: 320px; padding: 6px 10px; border-radius: 6px;
      background: var(--dsw-alias-bg-base, #26262a); color: var(--dsw-alias-label-primary);
      font-size: 12.5px; line-height: 1.4; border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.14));
      box-shadow: 0 8px 24px rgba(0,0,0,.35); }
    [data-menu-notice][hidden] { display: none; }
  `
  const bar = document.createElement('div')
  bar.setAttribute('role', 'menubar')
  let restoreEditor = (): void => {}
  const rememberEditor = (event: FocusEvent): void => {
    const target = event.composedPath()[0]
    if (!(target instanceof HTMLElement) || target === host || shadow.contains(target)) return
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)
      && !target.matches('[contenteditable="true"]')) return
    const selection = document.getSelection()
    const ranges = selection === null ? [] : Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange())
    const input = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : undefined
    const start = input?.selectionStart
    const end = input?.selectionEnd
    const direction = input?.selectionDirection
    restoreEditor = () => {
      if (!target.isConnected) return
      target.focus({ preventScroll: true })
      if (input !== undefined && start != null && end != null) input.setSelectionRange(start, end, direction ?? undefined)
      else if (selection !== null && ranges.length > 0) {
        selection.removeAllRanges()
        for (const range of ranges) selection.addRange(range)
      }
    }
  }
  document.addEventListener('focusout', rememberEditor, true)
  const buttons: HTMLButtonElement[] = []
  const createButton = (name: string): HTMLButtonElement => {
    const index = buttons.length
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('role', 'menuitem')
    button.setAttribute('aria-haspopup', 'menu')
    button.setAttribute('aria-expanded', 'false')
    button.tabIndex = index === 0 ? 0 : -1
    button.addEventListener('pointerdown', (event) => { event.preventDefault() })
    button.addEventListener('mousedown', (event) => { event.preventDefault() })
    const open = async (): Promise<void> => {
      if (button.getAttribute('aria-expanded') === 'true') return
      const rect = button.getBoundingClientRect()
      button.setAttribute('aria-expanded', 'true')
      if (document.activeElement === host) restoreEditor()
      try { await ipcRenderer.invoke(DESKTOP_IPC.windowsMenu, name, rect.left, rect.bottom) }
      catch (error) { console.error('Desktop caption menu failed', error) }
      finally { button.setAttribute('aria-expanded', 'false') }
    }
    button.addEventListener('click', () => { void open() })
    button.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        const step = event.key === 'ArrowLeft' ? -1 : 1
        const next = buttons[(buttons.indexOf(button) + step + buttons.length) % buttons.length]
        button.tabIndex = -1
        next.tabIndex = 0
        next.focus()
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        void open()
      }
    })
    bar.append(button)
    buttons.push(button)
    return button
  }
  const applicationButton = createButton('application')
  const editButton = createButton('edit')

  // A caption menu entry that runs one plugin workflow. It is not a menu popup:
  // pressing it is the whole command, and the shell contributes no project
  // discovery, packaging or upload logic of its own.
  let messages = resolveDesktopLocale(document.documentElement.lang).messages
  const notice = document.createElement('div')
  notice.setAttribute('data-menu-notice', '')
  notice.setAttribute('role', 'status')
  notice.hidden = true
  let noticeTimer: ReturnType<typeof setTimeout> | undefined
  const showNotice = (text: string): void => {
    notice.textContent = text
    notice.hidden = false
    if (noticeTimer !== undefined) clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => { notice.hidden = true }, 4000)
  }
  const placeOrderButton = document.createElement('button')
  placeOrderButton.type = 'button'
  placeOrderButton.setAttribute('role', 'menuitem')
  placeOrderButton.setAttribute('data-place-order', '')
  placeOrderButton.tabIndex = -1
  placeOrderButton.innerHTML = `${CART_ICON}<span></span>`
  const placeOrderLabel = placeOrderButton.querySelector('span')
  placeOrderButton.addEventListener('pointerdown', (event) => { event.preventDefault() })
  placeOrderButton.addEventListener('mousedown', (event) => { event.preventDefault() })
  const runPlaceOrder = (): void => {
    const handle = placeOrderHandle()
    if (handle?.placeOrder === undefined) { showNotice(messages.placeOrderUnavailable); return }
    try {
      if (handle.placeOrder() === false) showNotice(messages.placeOrderUnavailable)
    } catch (error) {
      console.error('Desktop place order menu failed', error)
      showNotice(messages.placeOrderFailed)
    }
  }
  placeOrderButton.addEventListener('click', runPlaceOrder)
  placeOrderButton.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const step = event.key === 'ArrowLeft' ? -1 : 1
      const next = buttons[(buttons.indexOf(placeOrderButton) + step + buttons.length) % buttons.length]
      placeOrderButton.tabIndex = -1
      next.tabIndex = 0
      next.focus()
    } else if (event.key === 'Enter' || event.key === 'ArrowDown' || event.key === ' ') {
      event.preventDefault()
      runPlaceOrder()
    }
  })
  bar.append(placeOrderButton)
  buttons.push(placeOrderButton)
  shadow.append(style, bar, notice)
  const mount = (): void => {
    // AppFrame owns this seat; boot readiness alone precedes the rendered application.
    if (document.querySelector('[data-shell-overlay]') === null) return
    document.body.append(host)
    observer.disconnect()
  }
  const observer = new MutationObserver(mount)
  observer.observe(document.body, { childList: true, subtree: true })
  mount()
  const update = (): void => {
    messages = resolveDesktopLocale(document.documentElement.lang).messages
    bar.setAttribute('aria-label', messages.menuBar)
    applicationButton.textContent = messages.application
    editButton.textContent = messages.edit
    if (placeOrderLabel !== null) placeOrderLabel.textContent = messages.placeOrder
    placeOrderButton.setAttribute('aria-label', messages.placeOrder)
    placeOrderButton.title = messages.placeOrder
  }
  update()
  return {
    update,
    dispose: () => {
      observer.disconnect()
      document.removeEventListener('focusout', rememberEditor, true)
      if (noticeTimer !== undefined) clearTimeout(noticeTimer)
      host.remove()
    },
  }
}
