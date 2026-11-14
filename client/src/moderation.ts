// Shared pieces for blocking and server moderation on the client: the timeout lengths on offer,
// how a moment and a length of time are worded, how an audit entry reads as a sentence, and a hook
// that re-renders when the next timeout runs out.
//
// Everything these describe is decided and enforced by the server (server/services/blocks.js,
// server/services/moderation.js). Nothing here grants or withholds anything; it only words it.
import { useEffect, useState } from 'react'

/** The API helper App.jsx uses for every authenticated call. */
export type AuthedFetch = (path: string, opts?: RequestInit) => Promise<Response>

/** In-app replacement for window.confirm (App.jsx askConfirm). Resolves true, or null if cancelled. */
export type AskConfirm = (opts: { title?: string; message?: string; submitLabel?: string }) => Promise<true | null>

/** Mirrors REASON_MAX in server/services/moderation.js. */
export const REASON_MAX = 300

// The lengths offered. The server takes any whole number of minutes from 1 to 28 days; these are
// the ones a person reaches for.
export const TIMEOUT_CHOICES = [
  { minutes: 5, label: '5 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 24 * 60, label: '1 day' },
  { minutes: 7 * 24 * 60, label: '1 week' },
] as const

/** One row of GET /blocks. */
export interface BlockedPerson {
  username: string
  userId: string
  blockedAt: number
}

/** One row of GET /servers/:id/bans. */
export interface ServerBan {
  username: string
  bannedBy: string | null
  reason: string | null
  bannedAt: number
}

/** One entry of GET /servers/:id/audit. */
export interface AuditEntry {
  id: number
  ts: number
  actor: string | null
  action: string
  target: string | null
  detail: Record<string, unknown> | null
}

/** A timeout the signed-in person is under, with `until` already on this device's clock. */
export interface OwnTimeout {
  until: number
  reason: string | null
  by: string | null
}

/** "5 minutes", "1 hour", "3 days": a number of minutes in the largest unit that divides it. */
export function formatDuration(minutes: number): string {
  const units: [number, string][] = [[7 * 24 * 60, 'week'], [24 * 60, 'day'], [60, 'hour']]
  for (const [size, name] of units) {
    if (minutes >= size && minutes % size === 0) {
      const n = minutes / size
      return `${n} ${name}${n === 1 ? '' : 's'}`
    }
  }
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

/**
 * A moment as a person would say it: "14:05" today, "tomorrow at 14:05", else "Tue 3 Dec, 14:05".
 * `sayToday` spells today out ("today at 14:05"), for a list of things that happened, where a bare
 * time would read as if it were missing its day.
 */
export function formatMoment(ms: number, now: number = Date.now(), sayToday = false): string {
  const when = new Date(ms)
  const time = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const dayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((dayOf(when) - dayOf(new Date(now))) / 86_400_000)
  if (days === 0) return sayToday ? `today at ${time}` : time
  if (days === 1) return `tomorrow at ${time}`
  if (days === -1) return `yesterday at ${time}`
  const sameYear = when.getFullYear() === new Date(now).getFullYear()
  const date = when.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })
  return `${date}, ${time}`
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const reasonSuffix = (detail: Record<string, unknown> | null): string => {
  const reason = text(detail?.reason)
  return reason ? ` — reason: ${reason}` : ''
}

/**
 * An audit entry as one readable sentence: "ann timed out ben for 1 hour — reason: spam".
 * An action this build does not know (a newer server) still reads as who and what.
 */
export function describeAudit(entry: AuditEntry): string {
  const actor = entry.actor || 'Someone'
  const target = entry.target || 'someone'
  const d = entry.detail
  switch (entry.action) {
    case 'member.kick': return `${actor} kicked ${target}`
    case 'member.ban': return `${actor} banned ${target}${d?.wasMember === false ? ' (who was not a member)' : ''}${reasonSuffix(d)}`
    case 'member.unban': return `${actor} unbanned ${target}`
    case 'member.timeout': {
      const minutes = typeof d?.minutes === 'number' ? d.minutes : null
      return `${actor} timed out ${target}${minutes ? ` for ${formatDuration(minutes)}` : ''}${reasonSuffix(d)}`
    }
    case 'member.timeout_lifted': return `${actor} removed ${target}’s time out`
    case 'member.role': return d?.to === 'admin' ? `${actor} made ${target} an admin` : `${actor} removed ${target} as an admin`
    case 'member.invite': return `${actor} added ${target} to the server`
    case 'member.join': return `${actor} joined through an invite link`
    case 'member.leave': return `${actor} left the server`
    case 'channel.create': return `${actor} created the ${d?.privacy === 'private' ? 'private ' : ''}${d?.type === 'voice' ? 'voice' : 'text'} channel ${text(d?.name) || '(unnamed)'}`
    case 'channel.rename': return `${actor} renamed the channel ${text(d?.from)} to ${text(d?.to)}`
    case 'channel.delete': return `${actor} deleted the channel ${text(d?.name) || '(unnamed)'}`
    case 'channel.access_grant': return `${actor} gave ${target} access to ${text(d?.channel) || 'a private channel'}`
    case 'channel.access_remove': return `${actor} removed ${target}’s access to ${text(d?.channel) || 'a private channel'}`
    case 'server.rename': return `${actor} renamed the server from “${text(d?.from)}” to “${text(d?.to)}”`
    case 'server.icon': return d?.change === 'cleared' ? `${actor} removed the server icon` : `${actor} changed the server icon`
    case 'invite.create': {
      const limits = [
        typeof d?.expiresAt === 'number' ? 'with an expiry' : 'that never expires',
        typeof d?.maxUses === 'number' ? `${d.maxUses} use${d.maxUses === 1 ? '' : 's'}` : 'unlimited uses',
      ]
      return `${actor} created an invite link ${limits.join(', ')}`
    }
    case 'invite.revoke': return `${actor} revoked an invite link${text(d?.createdBy) && d?.createdBy !== entry.actor ? ` made by ${text(d?.createdBy)}` : ''}`
    case 'app_rooms.reset': return `${actor} reset the app rooms`
    default: return `${actor}: ${entry.action}${entry.target ? ` (${entry.target})` : ''}`
  }
}

// setTimeout takes a 32-bit number of milliseconds (about 24.8 days); a 28-day timeout is longer.
// Past the limit the timer fires at once, so a wait that long is taken in steps.
const MAX_TIMER_MS = 2_000_000_000

/**
 * "Now", refreshed at each of the given moments as it passes. A timeout ends by the clock, with no
 * event from the server, so this is what makes a banner or a member-list marker disappear on time.
 * @param moments ms timestamps on this device's clock; ones already past are ignored
 */
export function useExpiry(moments: number[]): number {
  const [now, setNow] = useState(() => Date.now())
  const next = moments.filter((m) => m > now).reduce((soonest, m) => Math.min(soonest, m), Infinity)
  useEffect(() => {
    if (!Number.isFinite(next)) return undefined
    // A little past the moment, so the comparison that follows is certain to see it as over.
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(Math.max(next - Date.now(), 0) + 50, MAX_TIMER_MS))
    return () => window.clearTimeout(timer)
  }, [next, now])
  return now
}
