vi.mock('../src/web-document.ts', () => ({
  authenticateWebHost: async () => 'test-cookie', serveWebDocument: vi.fn(), forwardWebRequest: vi.fn(), removeLegacyHostCookies: async () => {},
}))
/** Huaqiu fork startup enters the workspace directly; the upstream sign-in welcome never opens. */

import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindowConstructorOptions } from 'electron'
import type { DesktopLocale } from '../src/locale.ts'
import type { AccountView } from '@deepseek-ai/dsh-deepseek-account/types'
import { DESKTOP_IPC } from '../src/ipc.ts'

const state = vi.hoisted(() => ({
  appListeners: new Map<string, (...args: unknown[]) => void>(),
  dialogLocale: undefined as (() => DesktopLocale) | undefined,
  beforeRead: vi.fn(async () => {}),
  openExternal: vi.fn((_url: string) => Promise.resolve()),
  expiryListener: undefined as (() => void) | undefined,
  accountListener: undefined as ((value: AccountView) => void) | undefined,
  quit: vi.fn(),
  startHost: vi.fn().mockResolvedValue({ url: 'http://127.0.0.1:3080/?token=test', injections: [] }),
  stopHost: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  loadWorkspace: vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined),
  showWorkspace: vi.fn(),
  showInactiveWorkspace: vi.fn(),
  focusWorkspace: vi.fn(),
  moveTopWorkspace: vi.fn(),
  openDevTools: vi.fn(),
  preference: 'zh',
  hasApiKey: false,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
  contents: undefined as { mainFrame: { url: string } } | undefined,
  windowOptions: undefined as BrowserWindowConstructorOptions | undefined,
  menu: vi.fn(),
  nativeTheme: { themeSource: 'system', shouldUseDarkColors: false },
}))

vi.mock('../src/crash-report.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/crash-report.ts')>(),
  writeCrashReport: vi.fn(async () => undefined),
  pruneCrashReports: vi.fn(async () => {}),
}))
vi.mock('electron', () => ({
  shell: { openExternal: state.openExternal },
  app: {
    isPackaged: false,
    name: 'Harness',
    requestSingleInstanceLock: () => true,
    setAsDefaultProtocolClient: vi.fn(),
    whenReady: () => Promise.resolve(),
    getLocale: () => 'en',
    getVersion: () => '1.0.0',
    setAboutPanelOptions: vi.fn(),
    getAppPath: () => '/development-app',
    getPath: (name: string) => name === 'userData' ? '/desktop-user-data' : `/development-${name}`,
    setAppLogsPath: vi.fn(),
    getPreferredSystemLanguages: () => ['en-US'],
    on: (name: string, callback: (...args: unknown[]) => void) => { state.appListeners.set(name, callback) },
    quit: state.quit,
    exit: vi.fn(),
  },
  powerMonitor: { on: vi.fn(), off: vi.fn() },
  BrowserWindow: class {
    constructor(options: BrowserWindowConstructorOptions) { state.windowOptions = options }
    private ready: (() => void) | undefined
    webContents = { mainFrame: { url: 'dsh-app://app/' }, setWindowOpenHandler: vi.fn(),
      on: vi.fn(), once: vi.fn(), send: vi.fn(), openDevTools: state.openDevTools }
    static getAllWindows() { return [] }
    once(name: string, callback: () => void) { if (name === 'ready-to-show') this.ready = callback; return this }
    on() { return this }
    isDestroyed() { return false }
    isMinimized() { return false }
    restore = vi.fn()
    focus = state.focusWorkspace
    moveTop = state.moveTopWorkspace
    hide = vi.fn()
    show = state.showWorkspace
    showInactive = state.showInactiveWorkspace
    async loadURL(url: string) { state.contents = this.webContents; await state.loadWorkspace(url); this.ready?.() }
  },
  nativeTheme: state.nativeTheme,
  session: { defaultSession: {
    on: vi.fn(), cookies: {},
    setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(), webRequest: { onBeforeSendHeaders: vi.fn() },
  } },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  ipcMain: {
    handle: (name: string, callback: (...args: unknown[]) => unknown) => { state.handlers.set(name, callback) },
    on: (name: string, callback: (...args: unknown[]) => void) => { state.listeners.set(name, callback) },
  },
  dialog: { showErrorBox: vi.fn(), showMessageBox: vi.fn() },
  Menu: { buildFromTemplate: state.menu, setApplicationMenu: vi.fn() },
  nativeImage: { createFromPath: (path: string) => ({ path }) },
}))
// The Windows tray relabels through Menu as well; keep the menu call counts below platform-neutral.
vi.mock('../src/tray.ts', () => ({ DesktopTray: class { relabel() {} dispose() {} } }))

vi.mock('../src/paths.ts', () => ({ resolveDesktopPaths: () => ({ profile: '/profile' }) }))
vi.mock('../src/settings.ts', () => ({ readDesktopSettings: () => ({ updates: { allowTestAuthPopupWindow: false } }) }))
vi.mock('../src/login-shell-environment.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/login-shell-environment.ts')>(),
  readDesktopLoginShellEnvironment: async (base: NodeJS.ProcessEnv) => ({ environment: base, failures: [] }),
}))
vi.mock('../src/project-manager.ts', () => ({ DesktopProjectManager: class {
  applyRelease = vi.fn(async () => {})
  canRecoverProfile = vi.fn(() => true)
} }))
vi.mock('../src/host-process.ts', () => ({
  DesktopHostProcess: class {
    start = state.startHost
    stop = state.stopHost
    fetch() {
      return Promise.resolve(Response.json({
        loggedIn: false, hasApiKey: state.hasApiKey, writable: true, localePreference: state.preference,
      }))
    }
  },
}))
vi.mock('../src/welcome-backend.ts', () => ({
  connectDesktopWelcome: () => ({
    analyticsEnabled: async () => false,
    readLocalePreference: async () => state.preference,
    read: async () => {
      await state.beforeRead()
      return { loggedIn: false, hasApiKey: state.hasApiKey, writable: true, localePreference: state.preference }
    },
    save: async () => ({ ok: true }),
    account: {
      watch: (listener: (value: AccountView) => void, _failed: () => void, expired: () => void) => {
        state.accountListener = listener
        state.expiryListener = expired
        return () => {}
      },
    },
  }),
}))
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  readFile: vi.fn(async () => '{}'),
}))
vi.mock('../src/update-dialog.ts', () => ({ DesktopUpdateDialog: class {
  constructor(_preload: string, locale: () => DesktopLocale) { state.dialogLocale = locale }
  dispose() {}
} }))
vi.mock('../src/update-coordinator.ts', () => ({ DesktopUpdateCoordinator: class {
  state = { phase: 'idle' }
  check = vi.fn(async () => this.state)
  dispose = vi.fn()
} }))

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('opens the workspace directly and keeps it through account changes', async () => {
  vi.resetModules()
  vi.clearAllMocks()
  state.preference = 'zh'
  state.hasApiKey = false
  vi.stubEnv('DSH_CLIENT_VERSION', '1.2.3')
  vi.stubEnv('DSH_DESKTOP_DEV_PROJECT_DIR', '/development-profile')
  vi.stubEnv('DSH_DESKTOP_NODE_BINARY', '/runtime/node')
  vi.stubEnv('DSH_DESKTOP_PNPM_ENTRY', '/runtime/pnpm')
  vi.stubEnv('DSH_DESKTOP_DSH_DIR', '/runtime/dsh')
  vi.stubEnv('DSH_DESKTOP_PRIMARY_RUNTIME_DIR', '/runtime/primary-runtime')
  vi.stubEnv('DSH_DESKTOP_HOST_INSPECT_PORT', undefined)
  vi.stubEnv('DSH_DESKTOP_OPEN_DEVTOOLS', '0')
  vi.stubEnv('DSH_DESKTOP_MANDATORY_UPDATE_CONFIG', undefined)
  vi.stubEnv('DSH_DESKTOP_UPDATE_JOURNAL_DIR', undefined)
  const reading = Promise.withResolvers<undefined>()
  state.beforeRead.mockReturnValueOnce(reading.promise)
  const activate = () => {
    state.appListeners.get('second-instance')!()
    state.appListeners.get('open-url')!({ preventDefault: vi.fn() }, 'dsh://open')
  }
  await import('../src/main.ts')
  await vi.waitFor(() => { expect(state.beforeRead).toHaveBeenCalledOnce() })
  try {
    activate()
    // The startup preference read owns the first window; activation cannot reveal it early either.
    expect(state.loadWorkspace).toHaveBeenCalledExactlyOnceWith('dsh-app://app/')
    expect(state.showWorkspace).not.toHaveBeenCalled()
  } finally {
    reading.resolve(undefined)
  }
  await vi.waitFor(() => { expect(state.showWorkspace).toHaveBeenCalledOnce() })
  expect(state.startHost).toHaveBeenCalledOnce()
  // The sole window carries the workspace geometry and the application preload, not the welcome shell.
  expect(state.windowOptions).toMatchObject({ width: 1280, webPreferences: { contextIsolation: true, sandbox: true } })
  expect(state.windowOptions!.webPreferences!.preload).toMatch(/preload-app\.cjs$/u)
  expect(state.dialogLocale!().id).toBe('zh-CN')
  const contents = state.contents as { mainFrame: { url: string }; send: ReturnType<typeof vi.fn> }
  expect(contents.send).toHaveBeenCalledWith(DESKTOP_IPC.enterWorkspace)
  const event = { sender: contents, senderFrame: contents.mainFrame }
  const bootstrap = state.handlers.get(DESKTOP_IPC.localeBootstrap)!
  expect(await bootstrap(event)).toEqual({ languages: ['en-US'], preference: 'zh' })
  const attemptId = 'login' as NonNullable<AccountView['attempt']>['id']
  const account: AccountView = { status: 'signed-out', links: { usageUrl: '', topUpUrl: '' }, attempt: null }
  // A sign-in started from Settings still opens the browser in the application palette.
  state.accountListener!({ ...account, attempt: { id: attemptId, phase: 'waiting-browser', authorizeUrl: 'https://example.test/login' } })
  expect(state.openExternal).toHaveBeenCalledExactlyOnceWith('https://example.test/login?theme=light')
  state.nativeTheme.shouldUseDarkColors = true
  state.accountListener!({ ...account, attempt: { id: 'login-dark' as typeof attemptId, phase: 'waiting-browser', authorizeUrl: 'https://example.test/login' } })
  expect(state.openExternal).toHaveBeenLastCalledWith('https://example.test/login?theme=dark')
  state.nativeTheme.shouldUseDarkColors = false
  // A settled attempt returns focus once; the same attempt is not returned twice.
  state.focusWorkspace.mockClear()
  state.accountListener!({ ...account, attempt: { id: 'failed' as typeof attemptId, phase: 'failed' } })
  expect(state.focusWorkspace).toHaveBeenCalledOnce()
  state.accountListener!({ ...account, attempt: { id: 'failed' as typeof attemptId, phase: 'failed' } })
  expect(state.focusWorkspace).toHaveBeenCalledOnce()
  // Signing out never returns to the skipped welcome or reloads the running workspace.
  state.loadWorkspace.mockClear()
  state.showWorkspace.mockClear()
  state.accountListener!({ ...account, status: 'credential-stored', attempt: null })
  state.accountListener!({ ...account, status: 'signed-out', attempt: null })
  await Promise.resolve()
  expect(state.loadWorkspace).not.toHaveBeenCalled()
  expect(state.showWorkspace).not.toHaveBeenCalled()
  expect(state.beforeRead).toHaveBeenCalledOnce()
  // An expired session keeps the preconfigured models usable instead of blocking on onboarding.
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  state.expiryListener!()
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('session expired'))
  expect(state.loadWorkspace).not.toHaveBeenCalled()
  expect(state.quit).not.toHaveBeenCalled()
  expect(state.stopHost).not.toHaveBeenCalled()
})
