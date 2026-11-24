/**
 * The right panel's corner buttons, drawn identically at both ends of the same
 * gesture and beside it: the conversation header's corner while the panel is
 * hidden, and the panel's own top-right corner while it is shown (collapse and
 * presentation switch).
 *
 * One definition rather than three is what keeps those ends from drifting apart:
 * the toggle is the same affordance at the same place in the user's eye, and the
 * presentation switch shares its 28px compact Button, 15px glyph and hover fill
 * so the expanded corner reads as one row rather than two different widgets.
 * The toggle glyph is the left sidebar's collapse icon mirrored, which moves the
 * divider to the panel's own edge.
 */
import clsx from 'clsx'
import type { ReactNode } from 'react'
import { Button, IconPanelLeftOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './PanelToggleButton.module.css'

/** Which control a button marks, for tests and capture tooling. */
export type PanelChromeMarker = 'data-sidebar-right-expand' | 'data-sidebar-right-toggle' | 'data-sidebar-right-mode'

/** What a corner button supplies; everything visual is fixed here. */
interface PanelChromeButtonProps {
  /** The tooltip's text: what the click will do in the sentence the copy module owns. */
  readonly label: string
  /** The button's accessible name, which the hidden tooltip does not supply. */
  readonly ariaLabel: string
  /** The effective binding shown in the tooltip, when the host advertises one. */
  readonly shortcutKeys?: readonly string[] | undefined
  /** The same binding in `aria-keyshortcuts` form. */
  readonly ariaKeyshortcuts?: string | undefined
  /** The click's effect. */
  readonly onClick: () => void
  /** The data attribute naming this control. */
  readonly marker: PanelChromeMarker
  /** Its value, for a marker that carries state rather than presence. */
  readonly markerValue?: string | undefined
  /** The 15px artwork; sizing and colour come from the shared stylesheet. */
  readonly glyph: ReactNode
  /** Drop the click and the focus, keeping the footprint (mobile, while shown). */
  readonly disabled?: boolean | undefined
  /** Keep the footprint but draw nothing (mobile, while shown). */
  readonly visuallyHidden?: boolean | undefined
  /** Suppress the tooltip, which a disabled button cannot show anyway. */
  readonly tooltipDisabled?: boolean | undefined
}

/** One compact icon button, the only shape the panel's corner draws. */
function PanelChromeButton({
  label, ariaLabel, shortcutKeys, ariaKeyshortcuts, onClick, marker, markerValue, glyph,
  disabled, visuallyHidden, tooltipDisabled,
}: PanelChromeButtonProps): ReactNode {
  return (
    <Tooltip label={label} shortcutKeys={shortcutKeys} side="bottom" delayMs={500} disabled={tooltipDisabled ?? false}>
      <Button
        size="sm"
        className={clsx(css.button, visuallyHidden === true && css.visuallyHidden)}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-keyshortcuts={ariaKeyshortcuts}
        {...{ [marker]: markerValue ?? '' }}
        onClick={onClick}
      >
        {glyph}
      </Button>
    </Tooltip>
  )
}

/** Which end of the gesture a toggle button marks. */
export type PanelToggleMarker = 'data-sidebar-right-expand' | 'data-sidebar-right-toggle'

/** What either end of the gesture supplies; everything visual is fixed here. */
export interface PanelToggleButtonProps {
  /** The tooltip's text: what the click will do in the sentence the copy module owns. */
  readonly label: string
  /** The button's accessible name, which the hidden tooltip does not supply. */
  readonly ariaLabel: string
  /** The effective binding shown in the tooltip, when the host advertises one. */
  readonly shortcutKeys?: readonly string[] | undefined
  /** The same binding in `aria-keyshortcuts` form. */
  readonly ariaKeyshortcuts?: string | undefined
  /**
   * The click's effect.
   *
   * The two ends pass different actions rather than a mode: expanding a hidden
   * panel and collapsing a shown one are distinct commits, not one toggle.
   */
  readonly onToggle: () => void
  /** The data attribute naming this end. */
  readonly marker: PanelToggleMarker
  /** Drop the click and the focus, keeping the footprint (mobile, while shown). */
  readonly disabled?: boolean
  /** Keep the footprint but draw nothing (mobile, while shown). */
  readonly visuallyHidden?: boolean
  /** Suppress the tooltip, which a disabled button cannot show anyway. */
  readonly tooltipDisabled?: boolean
}

/** Either end of the expand/collapse gesture: the mirrored panel icon. */
export function PanelToggleButton({
  label, ariaLabel, shortcutKeys, ariaKeyshortcuts, onToggle, marker, disabled, visuallyHidden, tooltipDisabled,
}: PanelToggleButtonProps): ReactNode {
  return (
    <PanelChromeButton
      label={label} ariaLabel={ariaLabel} shortcutKeys={shortcutKeys} ariaKeyshortcuts={ariaKeyshortcuts}
      onClick={onToggle} marker={marker}
      glyph={<IconPanelLeftOutlineRegular className={css.icon} />}
      disabled={disabled} visuallyHidden={visuallyHidden} tooltipDisabled={tooltipDisabled}
    />
  )
}

/** Expand-to-viewport glyph from the shared product artwork. */
function FullscreenGlyph(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.33203 10.4054V13.1681C2.33229 13.444 2.55605 13.6681 2.83203 13.6681H5.49512V14.6681H2.83203C2.00376 14.6681 1.33229 13.9963 1.33203 13.1681V10.4054H2.33203ZM14.6689 13.1681C14.6687 13.996 13.9968 14.6676 13.1689 14.6681H10.4951V13.6681H13.1689C13.4445 13.6676 13.6687 13.4437 13.6689 13.1681V10.4054H14.6689V13.1681ZM13.1689 1.33118C13.9969 1.33163 14.6688 2.00315 14.6689 2.83118V5.4054H13.6689V2.83118C13.6688 2.55544 13.4446 2.33162 13.1689 2.33118H10.4951V1.33118H13.1689ZM5.49512 2.33118H2.83203C2.55598 2.33118 2.33218 2.55516 2.33203 2.83118V5.4054H1.33203V2.83118C1.33218 2.00288 2.00369 1.33118 2.83203 1.33118H5.49512V2.33118Z" fill="currentColor" />
    </svg>
  )
}

/** Restore-from-fullscreen glyph from the shared product artwork. */
function ExitFullscreenGlyph(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M9 2.5V6C9 6.26522 9.10536 6.51957 9.29289 6.70711C9.48043 6.89464 9.73478 7 10 7H13.5" stroke="currentColor" />
      <path d="M7 13.5V10C7 9.73478 6.89464 9.48043 6.70711 9.29289C6.51957 9.10536 6.26522 9 6 9H2.5" stroke="currentColor" />
    </svg>
  )
}

/** What the presentation switch supplies; everything visual is fixed here. */
export interface PanelFullscreenButtonProps {
  /** Whether the panel currently covers the viewport. */
  readonly fullscreen: boolean
  readonly label: string
  readonly ariaLabel: string
  readonly shortcutKeys?: readonly string[] | undefined
  readonly ariaKeyshortcuts?: string | undefined
  readonly onToggle: () => void
}

/** The presentation switch, shown only while the panel is expanded. */
export function PanelFullscreenButton({
  fullscreen, label, ariaLabel, shortcutKeys, ariaKeyshortcuts, onToggle,
}: PanelFullscreenButtonProps): ReactNode {
  const next = fullscreen ? 'push' : 'fullscreen'
  return (
    <PanelChromeButton
      label={label} ariaLabel={ariaLabel} shortcutKeys={shortcutKeys} ariaKeyshortcuts={ariaKeyshortcuts}
      onClick={onToggle} marker="data-sidebar-right-mode" markerValue={next}
      glyph={fullscreen ? <ExitFullscreenGlyph /> : <FullscreenGlyph />}
    />
  )
}
