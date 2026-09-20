// @vitest-environment jsdom
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { Context } from '@deepseek-ai/cordis'
import { SettingsSchemaService } from '@deepseek-ai/dsh-client-ui-settings/src/client/schema.ts'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { SettingsScopeController } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-scope.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

/** Stateless schema service for scope construction in this jsdom fixture. */
const schemaService = new SettingsSchemaService(new Context())
import { WelcomeNotice } from '../src/client/WelcomeNotice.tsx'
import type { WelcomeNoticeProps } from '../src/client/WelcomeNotice.tsx'
import { decodeWelcomeSection, WelcomeNoticeStore } from '../src/client/welcome-store.ts'
import type { WelcomeSection } from '../src/client/welcome-store.ts'
import { en, zh } from '../src/client/locales.ts'
import {
  WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_SETTINGS_NAMESPACE,
  WELCOME_NOTICE_VERSION,
} from '../src/onboarding-copy.ts'

const WELCOME_NOTICE_COPY = {
  en: { title: en.welcomeTitle, body: en.welcomeBody, continueLabel: en.welcomeContinue },
  zh: { title: zh.welcomeTitle, body: zh.welcomeBody, continueLabel: zh.welcomeContinue },
}

afterEach(() => {
  cleanup()
  document.getElementById('root')?.remove()
})

/** The settings namespace answers over the Remote carrier, which has no envelope. */
function remoteAnswer<T>(value: T) {
  return { ok: true as const, value }
}

function welcomeView(value: unknown, revision = 0) {
  return {
    ns: WELCOME_NOTICE_SETTINGS_NAMESPACE,
    schema: {},
    value,
    base: {},
    user: {},
    applies: 'live' as const,
    secrets: [],
    revision,
  }
}

type AttentionSnapshot = Parameters<Parameters<WelcomeNoticeProps['useSessionPendingInteraction']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionPendingInteraction: WelcomeNoticeProps['useSessionPendingInteraction'] = selector => selector(noAttention)

function mount(version?: string) {
  const appRoot = document.createElement('div')
  appRoot.id = 'root'
  document.body.append(appRoot)
  const mutate = vi.fn()
  const api = {
    settings: {
      describe: () => Promise.resolve(remoteAnswer({
        writable: true,
        hasDocument: false,
        namespaces: [welcomeView(version === undefined ? {} : { [WELCOME_NOTICE_ACK_FIELD]: version })],
      })),
      mutate,
    },
  }
  const ctx = { remote: api } as never
  const mirror = new SettingsDescribeMirror(ctx)
  const scope = new SettingsScopeController<WelcomeSection>(
    ctx,
    { namespace: WELCOME_NOTICE_SETTINGS_NAMESPACE, decode: decodeWelcomeSection },
    mirror,
    'host',
    schemaService,
  )
  const controller = new WelcomeNoticeStore(scope)
  void mirror.load()
  const complete = vi.fn()
  const unusedHook = (() => { throw new Error('unused standard hook') }) as never
  const props: WelcomeNoticeProps = {
    stepId: 'welcome-notice',
    complete,
    openSection: vi.fn(),
    useSessions: unusedHook,
    useSessionPendingInteraction,
    usePanelInfo, useResource,
    useWorkspaces: unusedHook,
    controller,
    t: key => en[key],
    useWelcome: bindSnapshotSelector(controller.store),
  }
  return { ...render(<WelcomeNotice {...props} />), complete, controller, mirror, mutate, appRoot }
}

describe('WelcomeNotice', () => {
  it('uses the exact owner copy in both GUI locales', () => {
    expect(WELCOME_NOTICE_COPY.en).toEqual({
      title: 'Internal Testing Notice',
      body: "DeepSeek Harness 0.1 remains in testing for Harness developers. Many areas need further improvement, and we welcome feedback from the developer community. DeepSeek Harness's core plugins and foundational APIs will continue to evolve rapidly over the coming months.\n\nWe look forward to exploring the limits of intelligence with developers around the world, building on open-source, open, reusable, and composable infrastructure. We welcome Harness developers everywhere to join the DSH plugin ecosystem.",
      continueLabel: 'Continue',
    })
    expect(en.welcomeBody).toBe(WELCOME_NOTICE_COPY.en.body)
    expect(zh.welcomeBody).toBe(WELCOME_NOTICE_COPY.zh.body)
  })

  it('never renders the modal, even on first launch without an acknowledgement', async () => {
    // Fork: the internal-testing notice is disabled, so the step must not
    // render regardless of whether the durable acknowledgement exists. It
    // completes immediately so the onboarding coordinator moves on.
    const firstLaunch = mount()
    await act(async () => {
      await firstLaunch.mirror.load()
      await firstLaunch.controller.load()
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(firstLaunch.complete).toHaveBeenCalledOnce()

    cleanup()
    const alreadyAcknowledged = mount(WELCOME_NOTICE_VERSION)
    await act(async () => {
      await alreadyAcknowledged.mirror.load()
      await alreadyAcknowledged.controller.load()
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(alreadyAcknowledged.complete).toHaveBeenCalledOnce()
  })
})
