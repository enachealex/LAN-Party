// Notification levels on the client: what the settings mean for sounds, in-page notifications and
// badges. The server holds the settings and enforces the push half (server/services/
// notificationSettings.js); it sends them with the unread counts (GET /unreads) and again whenever
// they change ('notifications:updated'). Everything here is a pure reading of that one object, so
// the channel list, the rail and the alert code cannot disagree about what a level is.
//
//   all       every message alerts, not only mentions
//   mentions  the default: what the app did before levels existed
//   none      muted: no sound, no notification, not even for a mention. The count is still shown
//             on the row (dimmed) and stays out of the server tile's badge and the Messages badge.

export type NotificationLevel = 'all' | 'mentions' | 'none'

export interface NotificationSettings {
  /** serverId -> level. A server with no entry is 'mentions'. */
  servers: Record<string, NotificationLevel>
  /** serverId -> channelId -> level. A channel with no entry follows its server. */
  channels: Record<string, Record<string, NotificationLevel>>
  /** The other person's user id (the DM conversation's id) -> muted. */
  dms: Record<string, true>
  /** group id -> muted. */
  groups: Record<string, true>
}

/** What to set a level on: the body of PUT /notifications/settings, less the level. */
export type NotificationTarget =
  | { scope: 'server'; serverId: string }
  | { scope: 'channel'; serverId: string; channelId: string }
  | { scope: 'dm'; userId: string }
  | { scope: 'group'; groupId: string }

export const DEFAULT_LEVEL: NotificationLevel = 'mentions'
export const NO_NOTIFICATION_SETTINGS: NotificationSettings = { servers: {}, channels: {}, dms: {}, groups: {} }

export const LEVEL_LABELS: Record<NotificationLevel, string> = {
  all: 'All messages',
  mentions: 'Only @mentions',
  none: 'Nothing',
}
export const LEVELS: NotificationLevel[] = ['all', 'mentions', 'none']

const isLevel = (value: unknown): value is NotificationLevel => value === 'all' || value === 'mentions' || value === 'none'
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The settings as the server sent them, with anything malformed dropped rather than trusted. */
export function normalizeNotificationSettings(raw: unknown): NotificationSettings {
  const out: NotificationSettings = { servers: {}, channels: {}, dms: {}, groups: {} }
  if (!isRecord(raw)) return out
  if (isRecord(raw.servers)) for (const [id, level] of Object.entries(raw.servers)) if (isLevel(level)) out.servers[id] = level
  if (isRecord(raw.channels)) {
    for (const [serverId, channels] of Object.entries(raw.channels)) {
      if (!isRecord(channels)) continue
      for (const [channelId, level] of Object.entries(channels)) if (isLevel(level)) (out.channels[serverId] ||= {})[channelId] = level
    }
  }
  if (isRecord(raw.dms)) for (const [id, muted] of Object.entries(raw.dms)) if (muted === true) out.dms[id] = true
  if (isRecord(raw.groups)) for (const [id, muted] of Object.entries(raw.groups)) if (muted === true) out.groups[id] = true
  return out
}

/** The level a server is set to. */
export const serverLevel = (settings: NotificationSettings, serverId: string): NotificationLevel => settings.servers[serverId] || DEFAULT_LEVEL

/** A channel's own setting, or null when it follows its server. */
export const ownChannelLevel = (settings: NotificationSettings, serverId: string, channelId: string): NotificationLevel | null =>
  settings.channels[serverId]?.[channelId] || null

/** The level that applies to a channel: its own, else its server's. */
export const channelLevel = (settings: NotificationSettings, serverId: string, channelId: string): NotificationLevel =>
  ownChannelLevel(settings, serverId, channelId) || serverLevel(settings, serverId)

export const isDmMuted = (settings: NotificationSettings, userId: string | number): boolean => settings.dms[String(userId)] === true
export const isGroupMuted = (settings: NotificationSettings, groupId: string | number): boolean => settings.groups[String(groupId)] === true

/**
 * Per-server totals for the rail's badges, from per-channel counts: `{ serverId: { channelId: n } }`
 * in, `{ serverId: n }` out, with every muted channel left out. Used for the unread count and for
 * the mention count alike.
 */
export function badgeTotals(counts: Record<string, Record<string, number>>, settings: NotificationSettings): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const [serverId, channels] of Object.entries(counts || {})) {
    let sum = 0
    for (const [channelId, n] of Object.entries(channels || {})) {
      if (channelLevel(settings, serverId, channelId) !== 'none') sum += Number(n) || 0
    }
    totals[serverId] = sum
  }
  return totals
}

/** The ids of the channels of one server that are muted for me, of those given. */
export function mutedChannelIds(settings: NotificationSettings, serverId: string | null, channelIds: string[]): Set<string> {
  const muted = new Set<string>()
  if (!serverId) return muted
  for (const id of channelIds) if (channelLevel(settings, serverId, id) === 'none') muted.add(id)
  return muted
}

/** Unread group messages for the Messages badge: every group's count, less the muted ones. */
export function unmutedGroupUnread(groupUnread: Record<string, number>, settings: NotificationSettings): number {
  let sum = 0
  for (const [groupId, n] of Object.entries(groupUnread || {})) if (!isGroupMuted(settings, groupId)) sum += Number(n) || 0
  return sum
}
