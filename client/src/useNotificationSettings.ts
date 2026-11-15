import { useCallback, useRef, useState } from 'react'
import {
  NO_NOTIFICATION_SETTINGS, normalizeNotificationSettings,
  type NotificationLevel, type NotificationSettings, type NotificationTarget,
} from './notificationLevels'

/** The API helper App.jsx already uses for every authenticated call. */
type AuthedFetch = (path: string, opts?: RequestInit) => Promise<Response>

/**
 * My notification levels, and the one way to change them.
 *
 * The settings arrive from three places and all three go through `apply`: with the unread counts
 * when the app starts or reconnects (GET /unreads), in the answer to a change made here, and over
 * the socket when a change was made in another window ('notifications:updated'). Each carries the
 * whole settings object, so whichever lands last is simply the truth and there is nothing to merge.
 *
 * `settingsRef` is the same value for code that cannot re-read state: App's socket handlers are
 * bound once per connection, and a message that arrives after a mute must already be silent.
 */
export function useNotificationSettings(authedFetch: AuthedFetch, onError: (message: string) => void) {
  const [settings, setSettings] = useState<NotificationSettings>(NO_NOTIFICATION_SETTINGS)
  const settingsRef = useRef<NotificationSettings>(NO_NOTIFICATION_SETTINGS)
  // Both change identity on every render of App; the callbacks below must not.
  const fetchRef = useRef(authedFetch)
  fetchRef.current = authedFetch
  const errorRef = useRef(onError)
  errorRef.current = onError

  const apply = useCallback((raw: unknown) => {
    const next = normalizeNotificationSettings(raw)
    settingsRef.current = next
    setSettings(next)
  }, [])

  /** Set a level (or `null` to go back to the default / to following the server). */
  const setLevel = useCallback(async (target: NotificationTarget, level: NotificationLevel | null) => {
    try {
      const res = await fetchRef.current('/notifications/settings', { method: 'PUT', body: JSON.stringify({ ...target, level }) })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error((data && data.error) || "Couldn't change that notification setting")
      // Nothing is shown before the server has it: a setting that only exists on this screen would
      // look muted here while the phone goes on buzzing.
      if (data && data.settings) apply(data.settings)
    } catch (err) {
      errorRef.current(err instanceof Error && err.message ? err.message : "Couldn't change that notification setting")
    }
  }, [apply])

  const reset = useCallback(() => apply(null), [apply])

  return { settings, settingsRef, apply, setLevel, reset }
}
