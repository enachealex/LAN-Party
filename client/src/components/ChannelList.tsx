import { useEffect, useState, type HTMLAttributes, type MouseEvent, type ReactNode } from 'react'
import longPressProps from '../longPress'
import type { ChannelCategory } from '../permissions'

export interface ListedChannel {
  id: string
  name: string
  type: string
  privacy?: string
  categoryId?: string | null
}

/** What a right-click on a row hands to the pane's context menu (AppLeftPane renders it). */
export type ChannelMenuItem =
  | { kind: 'channel'; id: string; name: string; privacy?: string; type: string; categoryId: string | null; canUp: boolean; canDown: boolean }
  | { kind: 'category'; id: string; name: string; canUp: boolean; canDown: boolean }

/** A contextmenu event, or the look-alike longPress.js makes from a long press. */
type MenuEvent = { preventDefault: () => void; clientX: number; clientY: number }

interface ChannelListProps {
  channels: ListedChannel[]
  /** The categories this person is shown: the server only sends ones holding a channel they can see. */
  categories: ChannelCategory[]
  serverId: string | null
  activeChannel?: string | null
  channelUnreads: Record<string, number>
  channelMentions: Record<string, number>
  /** May create, rename and delete channels here: manage_channels, or anyone in the public commons. */
  canManage: boolean
  /** Whose collapsed categories to remember (the signed-in username). */
  collapseKey: string
  inVoice: boolean
  voiceServerId: string | null
  voiceChannelId: string | null
  onJoinChannel?: (channelId: string) => void
  onJoinVoice?: (channelId: string) => void
  onLeaveVoice?: () => void
  /** `categoryId` when the "+" of a category was used: the new channel is filed there. */
  onCreateChannel?: (type: 'text' | 'voice', categoryId?: string | null) => void
  onOpenMenu: (e: MenuEvent, item: ChannelMenuItem) => void
}

const SPEAKER_ICON_PATH = 'M12 3a9 9 0 0 0-9 9v3a3 3 0 0 0 3 3h1v-6H6a7 7 0 0 1 14 0v6h1a3 3 0 0 0 3-3v-3a9 9 0 0 0-9-9Zm-1 14h2v3h-2v-3Z'
const badge = (n: number) => (n > 99 ? '99+' : n)

// longPress.js is plain JS; what it returns is a set of touch handlers for any element.
const press = (handler: (e: MenuEvent) => void) => longPressProps(handler) as HTMLAttributes<HTMLElement>

// Which categories are folded away, remembered per person on this device. It is a preference
// about one's own view, so it lives in localStorage and never goes to the server.
function useCollapsedCategories(collapseKey: string) {
  const storageKey = `lanparty_collapsed_categories:${collapseKey}`
  const read = (): Set<string> => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || '[]')
      return new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : [])
    } catch { return new Set() }
  }
  const [collapsed, setCollapsed] = useState<Set<string>>(read)
  // Signing in as someone else on the same device shows their folds, not the last person's.
  useEffect(() => { setCollapsed(read()) }, [storageKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string) => setCollapsed((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    try { localStorage.setItem(storageKey, JSON.stringify([...next])) } catch { /* private mode: it just is not remembered */ }
    return next
  })
  return { collapsed, toggle }
}

/**
 * The server's channel list: the uncategorised text and voice channels under their two headings,
 * exactly as before categories existed, then each category with its channels in order.
 *
 * A category is a heading and nothing more. Which channels appear at all was decided by the
 * server (a private channel only reaches people on its access list, wherever it is filed), and
 * a category nobody can see into is never sent.
 */
export default function ChannelList({
  channels, categories, serverId, activeChannel, channelUnreads, channelMentions, canManage, collapseKey,
  inVoice, voiceServerId, voiceChannelId, onJoinChannel, onJoinVoice, onLeaveVoice, onCreateChannel, onOpenMenu,
}: ChannelListProps) {
  const { collapsed, toggle } = useCollapsedCategories(collapseKey)
  const known = new Set(categories.map((c) => c.id))
  // A channel whose category this person is not shown (or that is gone) is listed with the rest.
  const categoryOf = (ch: ListedChannel) => (ch.categoryId && known.has(ch.categoryId) ? ch.categoryId : null)
  const loose = channels.filter((ch) => !categoryOf(ch))
  const looseText = loose.filter((ch) => ch.type === 'text')
  const looseVoice = loose.filter((ch) => ch.type === 'voice')
  const inCall = (ch: ListedChannel) => inVoice && voiceServerId === serverId && voiceChannelId === ch.id

  // `list` is the list the channel is ordered within: that is what "Move up/down" walks.
  const row = (ch: ListedChannel, list: ListedChannel[]): ReactNode => {
    const index = list.findIndex((c) => c.id === ch.id)
    const item: ChannelMenuItem = { kind: 'channel', id: ch.id, name: ch.name, privacy: ch.privacy, type: ch.type, categoryId: categoryOf(ch), canUp: index > 0, canDown: index >= 0 && index < list.length - 1 }
    const openMenu = (e: MenuEvent) => onOpenMenu(e, item)
    // The menu holds nothing but channel management, so it only opens for someone who has that.
    const menuProps = canManage ? { onContextMenu: (e: MouseEvent) => openMenu(e), ...press(openMenu) } : {}
    const lock = ch.privacy === 'private' && <span className="dc-channel-lock" title="Private channel">🔒</span>
    if (ch.type === 'voice') {
      return (
        <div key={ch.id} className={`dc-channel-item-row ${activeChannel === ch.id ? 'active' : ''}`}>
          <button type="button" className="dc-channel-item" onClick={() => onJoinChannel?.(ch.id)} {...menuProps}>
            <span className="dc-channel-icon dc-channel-icon-voice">
              <svg className="dc-channel-speaker-svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={SPEAKER_ICON_PATH} /></svg>
            </span>
            <span>{ch.name}</span>
            {lock}
          </button>
          {inCall(ch) ? (
            <button type="button" className="dc-voice-join-btn leave" onClick={() => onLeaveVoice?.()} title="Leave voice">Leave</button>
          ) : (
            <button type="button" className="dc-voice-join-btn" onClick={() => onJoinVoice?.(ch.id)} title="Join voice">Join Voice</button>
          )}
        </div>
      )
    }
    const unread = channelUnreads[ch.id] || 0
    const mentions = channelMentions[ch.id] || 0
    return (
      <button
        key={ch.id}
        type="button"
        className={`dc-channel-item ${activeChannel === ch.id ? 'active' : ''} ${unread > 0 ? 'unread' : ''}`}
        onClick={() => onJoinChannel?.(ch.id)}
        {...menuProps}
      >
        <span className="dc-channel-icon"><span className="dc-channel-hash">#</span></span>
        <span>{ch.name}</span>
        {lock}
        {mentions > 0 && <span className="dc-channel-mention" title={`You were mentioned ${mentions === 1 ? 'once' : `${mentions} times`}`}>@{badge(mentions)}</span>}
        {unread > 0 && <span className="dc-channel-unread">{badge(unread)}</span>}
      </button>
    )
  }

  // The two headings every server has always had. With categories in use they are only kept for
  // someone who can create channels (it is where an uncategorised one is made) or when they
  // still hold something; a member is not shown an empty heading.
  const section = (label: string, type: 'text' | 'voice', list: ListedChannel[]) => {
    if (categories.length > 0 && list.length === 0 && !canManage) return null
    return (
      <div className="dc-channel-section">
        <div className="dc-channel-section-label">
          <span>{label}</span>
          {canManage && (
            <button type="button" className="dc-dm-add" aria-label={`Create ${type === 'voice' ? 'Voice' : 'Text'} Channel`} onClick={() => onCreateChannel?.(type)}>+</button>
          )}
        </div>
        {list.map((ch) => row(ch, list))}
      </div>
    )
  }

  return (
    <>
      {section('Text Channels', 'text', looseText)}
      {section('Voice Channels', 'voice', looseVoice)}
      {categories.map((cat, index) => {
        const list = channels.filter((ch) => categoryOf(ch) === cat.id)
        const folded = collapsed.has(cat.id)
        const unread = list.reduce((sum, ch) => sum + (channelUnreads[ch.id] || 0), 0)
        const mentions = list.reduce((sum, ch) => sum + (channelMentions[ch.id] || 0), 0)
        const item: ChannelMenuItem = { kind: 'category', id: cat.id, name: cat.name, canUp: index > 0, canDown: index < categories.length - 1 }
        const openMenu = (e: MenuEvent) => onOpenMenu(e, item)
        const menuProps = canManage ? { onContextMenu: (e: MouseEvent) => openMenu(e), ...press(openMenu) } : {}
        // Folded away, a category still shows where you are: the channel on screen and the call
        // you are in stay listed, so folding never hides the way back to either.
        const shown = folded ? list.filter((ch) => ch.id === activeChannel || inCall(ch)) : list
        return (
          <div key={cat.id} className="dc-channel-section dc-category">
            <div className="dc-channel-section-label dc-category-label">
              <button type="button" className="dc-category-toggle" aria-expanded={!folded} title={folded ? `Show the channels in ${cat.name}` : `Hide the channels in ${cat.name}`} onClick={() => toggle(cat.id)} {...menuProps}>
                <span className="dc-category-caret" aria-hidden="true">{folded ? '▸' : '▾'}</span>
                <span className="dc-category-name">{cat.name}</span>
              </button>
              {/* What is waiting in the channels a fold hides: the sum of their badges. */}
              {folded && mentions > 0 && <span className="dc-channel-mention" title={`${mentions} mention${mentions === 1 ? '' : 's'} in ${cat.name}`}>@{badge(mentions)}</span>}
              {folded && unread > 0 && <span className="dc-channel-unread" title={`${unread} unread in ${cat.name}`}>{badge(unread)}</span>}
              {canManage && (
                <button type="button" className="dc-dm-add" aria-label={`Create a channel in ${cat.name}`} onClick={() => onCreateChannel?.('text', cat.id)}>+</button>
              )}
            </div>
            {shown.map((ch) => row(ch, list))}
            {!folded && list.length === 0 && <div className="dc-category-empty">No channels yet</div>}
          </div>
        )
      })}
    </>
  )
}
