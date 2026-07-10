import React, { useState, useEffect, useMemo, useRef } from 'react'
import ProfileAvatar from './ProfileAvatar'
import { nameStyleToCss } from '../profileData'

const FRIENDS_ICON_URL = '/icons/friends-nav.png'
const CREATE_MESSAGE_ICON_URL = '/icons/create-message.png'
const ADD_FRIEND_ICON_URL = '/icons/add-friend.png'

// Varied demo profiles so you can preview how other users' customizations look.
const MOCK_PROFILES = {
  Tanis: { border: { preset: 'gold' }, overlay: 'glow', nameStyle: { id: 'gold' }, nameFont: 'serif', tags: [{ type: 'server', label: 'LAN Party' }, { type: 'custom', label: 'MVP' }] },
  domotropico: { border: { preset: 'neon' }, overlay: 'ring', nameStyle: { id: 'cyber' }, nameFont: 'mono', tags: [{ type: 'custom', label: 'DEV' }] },
  BC037138: { border: { preset: 'emerald' }, overlay: 'pulse', nameStyle: { id: 'gradient' }, nameFont: 'condensed' },
  CHEESYMAC8979: { border: { preset: 'rose' }, overlay: 'sparkle', nameStyle: { id: 'rainbow' }, nameFont: 'rounded', tags: [{ type: 'custom', label: 'GAMER' }] },
  jengas: { border: { preset: 'dashed' }, overlay: 'none', nameStyle: { id: 'fire' }, nameFont: 'default' },
  DBot: { border: { preset: 'custom', color: '#a855f7', width: 3, style: 'double' }, overlay: 'glow', nameStyle: { id: 'cyber' }, nameFont: 'mono', tags: [{ type: 'custom', label: 'BOT' }] },
}

export const MOCK_FRIENDS = [
  { id: 'f1', name: 'Tanis', status: 'online', avatar: '#5865f2', profile: MOCK_PROFILES.Tanis },
  { id: 'f2', name: 'domotropico', status: 'idle', avatar: '#3ba55c', activity: 'Windrose', profile: MOCK_PROFILES.domotropico },
  { id: 'f3', name: 'BC037138', status: 'online', avatar: '#faa61a', profile: MOCK_PROFILES.BC037138 },
  { id: 'f4', name: 'CHEESYMAC8979', status: 'dnd', avatar: '#eb459e', profile: MOCK_PROFILES.CHEESYMAC8979 },
  { id: 'f5', name: 'jengas', status: 'offline', avatar: '#747f8d', profile: MOCK_PROFILES.jengas },
]

export const MOCK_DIRECT_MESSAGES = [
  { id: 'dm1', name: 'Tanis', status: 'online', avatar: '#5865f2', profile: MOCK_PROFILES.Tanis },
  { id: 'dm2', name: 'domotropico', status: 'idle', activity: 'Windrose', avatar: '#3ba55c', profile: MOCK_PROFILES.domotropico },
  { id: 'dm3', name: 'BC037138', status: 'online', avatar: '#faa61a', profile: MOCK_PROFILES.BC037138 },
  { id: 'dm4', name: 'CHEESYMAC8979', status: 'dnd', avatar: '#eb459e', profile: MOCK_PROFILES.CHEESYMAC8979 },
  { id: 'dm5', name: 'DBot', status: 'online', avatar: '#5865f2', bot: true, profile: MOCK_PROFILES.DBot },
]

export const MOCK_GROUP_MESSAGES = [
  { id: 'g1', name: 'LAN Squad', preview: '3 members', avatar: '#5865f2' },
  { id: 'g2', name: 'Friday Night', preview: '8 members', avatar: '#3ba55c' },
  { id: 'g3', name: 'Dev Chat', preview: '5 members', avatar: '#eb459e' },
]

const NAV_META = {
  friends: { label: 'Friends', icon: FRIENDS_ICON_URL },
  messages: { label: 'Messages', icon: null },
}

function DmAvatar({ name, color, status, bot, unreadCount = 0, profile = null, resolveSrc = (u) => u }) {
  const initial = (name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?'
  const hasProfile = profile && (profile.avatarUrl || profile.border?.preset !== 'none' || (profile.overlay && profile.overlay !== 'none'))
  return (
    <div className="dc-dm-avatar-wrap">
      {hasProfile ? (
        <ProfileAvatar name={name} profile={profile} size={32} color={color} resolveSrc={resolveSrc} />
      ) : (
        <div className="dc-dm-avatar" style={{ background: color }}>
          {initial}
        </div>
      )}
      <span className={`dc-status-ring dc-status-${status}`} aria-hidden="true" />
      {bot && <span className="dc-bot-tag">BOT</span>}
      {unreadCount > 0 && (
        <span className="dc-avatar-unread-badge" aria-label={`${unreadCount} unread messages`}>
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
    </div>
  )
}

function CreateMessageButton({ onClick, className = '' }) {
  return (
    <button type="button" className={`dc-create-msg-btn ${className}`} onClick={onClick} title="Create Message" aria-label="Create Message">
      <img src={CREATE_MESSAGE_ICON_URL} alt="" draggable={false} />
    </button>
  )
}

function AddFriendButton({ onClick, className = '' }) {
  return (
    <button type="button" className={`dc-create-msg-btn dc-add-friend-btn ${className}`} onClick={onClick} title="Add a Friend" aria-label="Add a Friend">
      <img src={ADD_FRIEND_ICON_URL} alt="" draggable={false} />
    </button>
  )
}

function defaultLayout() {
  return [
    { type: 'nav', id: 'friends' },
    { type: 'nav', id: 'messages' },
  ]
}

function normalizeLayout(items) {
  const navs = items.filter((item) => item.type === 'nav')
  const sections = items.filter((item) => item.type === 'section')
  return [...navs, ...sections]
}

export default function HomeLeftPanel({
  activeNav = 'friends',
  onNavChange,
  onSelectFriend,
  selectedFriendId,
  onSelectDm,
  selectedDmId,
  onSelectGroup,
  selectedGroupId,
  onCreateMessage,
  onFriendVoiceChat,
  onFriendViewProfile,
  friends = [],
  pendingFriendRequests = [],
  pendingFriendCount = 0,
  onOpenAddFriend,
  onAcceptFriendRequest,
  onDeclineFriendRequest,
  outgoingFriendRequests = [],
  onCancelOutgoingFriendRequest,
  dmConversations = [],
  groupConversations = null,
  totalUnreadMessages = 0,
  unreadByChatId = {},
  groupUnread = {},
  resolveAvatarSrc = (u) => u,
}) {
  const [layout, setLayout] = useState(() => normalizeLayout(defaultLayout()))
  const setLayoutNormalized = (updater) => {
    setLayout((prev) => normalizeLayout(typeof updater === 'function' ? updater(prev) : updater))
  }
  const [search, setSearch] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const searchWrapRef = useRef(null)
  const [contextMenu, setContextMenu] = useState(null)
  // Right-click "Move to section" menu for DMs/groups: { kind:'dm'|'group', id, name, x, y }.
  const [dmMenu, setDmMenu] = useState(null)
  // User-created message sections and which conversation goes in which section.
  const [dmSections, setDmSections] = useState([]) // [{ id, name }]
  const [dmSectionMap, setDmSectionMap] = useState({}) // { [conversationId]: sectionId }
  // Manual ordering of conversations per bucket: { [sectionId | '__unsorted']: [convId,...] }.
  const [dmOrder, setDmOrder] = useState({})
  // Conversation id currently being dragged.
  const [dragConvId, setDragConvId] = useState(null)
  // Where the dragged row would land: { id: targetConvId, pos: 'above' | 'below' }.
  const [dropTarget, setDropTarget] = useState(null)
  const [dragIndex, setDragIndex] = useState(null)
  const [dragOverIndex, setDragOverIndex] = useState(null)
  const [pendingOrder, setPendingOrder] = useState([])
  const [pendingDragIndex, setPendingDragIndex] = useState(null)
  const [pendingDragOverIndex, setPendingDragOverIndex] = useState(null)

  useEffect(() => {
    const ids = pendingFriendRequests.map((r) => r.id)
    setPendingOrder((prev) => {
      const kept = prev.filter((id) => ids.includes(id))
      const added = ids.filter((id) => !kept.includes(id))
      return [...kept, ...added]
    })
  }, [pendingFriendRequests])

  const orderedPendingRequests = useMemo(() => {
    return pendingOrder
      .map((id) => pendingFriendRequests.find((r) => r.id === id))
      .filter(Boolean)
  }, [pendingOrder, pendingFriendRequests])

  const reorderPending = (from, to) => {
    if (from === to || from == null || to == null) return
    setPendingOrder((prev) => {
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }

  useEffect(() => {
    if (!contextMenu) return undefined
    const close = () => setContextMenu(null)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [contextMenu])

  useEffect(() => {
    if (!dmMenu) return undefined
    const close = () => setDmMenu(null)
    document.addEventListener('mousedown', close)
    document.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('scroll', close, true)
    }
  }, [dmMenu])

  const openDmMenu = (e, kind, item) => {
    e.preventDefault()
    e.stopPropagation()
    setDmMenu({ kind, id: item.id, name: item.name, x: e.clientX, y: e.clientY })
  }

  const UNSORTED = '__unsorted'
  const bucketOf = (convId) => dmSectionMap[convId] || UNSORTED

  // Remove a conversation id from every bucket's order list.
  const stripFromOrder = (order, convId) => {
    const next = {}
    for (const k of Object.keys(order)) next[k] = order[k].filter((id) => id !== convId)
    return next
  }

  // Assign a conversation to a section id (or null to remove from sections), appending to that
  // bucket's manual order.
  const moveConversationToSection = (conversationId, sectionId) => {
    setDmSectionMap((prev) => {
      const next = { ...prev }
      if (sectionId) next[conversationId] = sectionId
      else delete next[conversationId]
      return next
    })
    setDmOrder((prev) => {
      const cleared = stripFromOrder(prev, conversationId)
      const key = sectionId || UNSORTED
      return { ...cleared, [key]: [...(cleared[key] || []), conversationId] }
    })
    setDmMenu(null)
  }

  // Build the full ordered id list for a bucket (manual order first, then any leftovers),
  // so reordering accounts for rows not yet present in dmOrder.
  const orderedIdsForBucket = (bucketKey) => {
    const inBucket = (id) => (bucketKey === UNSORTED ? !dmSectionMap[id] : dmSectionMap[id] === bucketKey)
    const ids = (dmOrder[bucketKey] || []).filter(inBucket)
    const seen = new Set(ids)
    allConversations.forEach((_e, id) => { if (inBucket(id) && !seen.has(id)) ids.push(id) })
    return ids
  }

  // Drag-reorder: place `draggedId` above/below `targetId`, moving it into the target's bucket.
  const dropConversationAt = (draggedId, targetId, pos = 'above') => {
    if (!draggedId || draggedId === targetId) return
    const targetBucket = bucketOf(targetId)
    setDmSectionMap((prev) => {
      const next = { ...prev }
      if (targetBucket === UNSORTED) delete next[draggedId]
      else next[draggedId] = targetBucket
      return next
    })
    setDmOrder((prev) => {
      // Start from the bucket's full current order, then move the dragged id to the new spot.
      const list = orderedIdsForBucket(targetBucket).filter((id) => id !== draggedId)
      let idx = list.indexOf(targetId)
      if (idx < 0) idx = list.length
      else if (pos === 'below') idx += 1
      list.splice(idx, 0, draggedId)
      return { ...stripFromOrder(prev, draggedId), [targetBucket]: list }
    })
    setDropTarget(null)
  }

  // Class for a draggable row reflecting drag/drop indicator state.
  const rowClass = (convId) => {
    let c = 'dc-dm-li'
    if (dragConvId === convId) c += ' dragging'
    if (dropTarget?.id === convId) c += dropTarget.pos === 'above' ? ' drop-above' : ' drop-below'
    return c
  }

  // Shared drag props for a draggable conversation/friend row.
  const rowDragProps = (convId) => ({
    draggable: true,
    onDragStart: (e) => { setDragConvId(convId); e.dataTransfer.effectAllowed = 'move' },
    onDragEnd: () => { setDragConvId(null); setDropTarget(null) },
    onDragOver: (e) => {
      if (!dragConvId || dragConvId === convId) return
      e.preventDefault()
      const rect = e.currentTarget.getBoundingClientRect()
      const pos = e.clientY - rect.top < rect.height / 2 ? 'above' : 'below'
      setDropTarget((cur) => (cur?.id === convId && cur?.pos === pos ? cur : { id: convId, pos }))
    },
    onDrop: (e) => {
      e.preventDefault()
      e.stopPropagation() // don't let the section container also handle this drop
      const pos = dropTarget?.id === convId ? dropTarget.pos : 'above'
      dropConversationAt(dragConvId, convId, pos)
      setDragConvId(null)
    },
  })

  const createDmSectionAndMove = (conversationId) => {
    const name = window.prompt('New section name', 'New Section')
    if (!name?.trim()) { setDmMenu(null); return }
    const id = `dmsec-${Date.now()}`
    setDmSections((prev) => [...prev, { id, name: name.trim() }])
    moveConversationToSection(conversationId, id)
  }

  // Create an empty conversation section (drag people/chats into it afterwards).
  const createConversationSection = () => {
    const name = window.prompt('New section name', 'New Section')
    if (!name?.trim()) return
    setDmSections((prev) => [...prev, { id: `dmsec-${Date.now()}`, name: name.trim() }])
  }

  // Delete a section, returning its conversations to the unsorted bucket.
  const deleteSection = (sectionId) => {
    setDmSections((prev) => prev.filter((s) => s.id !== sectionId))
    setDmSectionMap((prev) => {
      const next = {}
      for (const k of Object.keys(prev)) if (prev[k] !== sectionId) next[k] = prev[k]
      return next
    })
    setDmOrder((prev) => { const n = { ...prev }; delete n[sectionId]; return n })
  }

  const openCreateMessage = (e) => {
    e.stopPropagation()
    onCreateMessage?.()
    onNavChange?.('messages')
  }

  const layoutNavEntries = layout
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.type === 'nav')
  const reorderTopLevel = (from, to) => {
    if (from === to || from == null || to == null) return
    setLayoutNormalized((prev) => {
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }

  const moveNavToSection = (navId, sectionId) => {
    setLayoutNormalized((prev) => {
      let extracted = null
      const without = prev
        .filter((item) => {
          if (item.type === 'nav' && item.id === navId) {
            extracted = item
            return false
          }
          return true
        })
        .map((item) => {
          if (item.type === 'section') {
            return { ...item, navIds: item.navIds.filter((id) => id !== navId) }
          }
          return item
        })
      if (!extracted) return prev
      return without.map((item) => {
        if (item.type === 'section' && item.id === sectionId && !item.navIds.includes(navId)) {
          return { ...item, navIds: [...item.navIds, navId], collapsed: false }
        }
        return item
      })
    })
  }

  const renderNavButton = (navId, indent = false) => {
    const meta = NAV_META[navId]
    if (!meta) return null
    const isMessages = navId === 'messages'
    const isFriends = navId === 'friends'
    return (
      <div key={navId} className={`dc-home-nav-row ${indent ? 'indented' : ''}`}>
        <button
          type="button"
          className={`dc-nav-item dc-home-nav-btn ${activeNav === navId ? 'active' : ''}`}
          onClick={() => onNavChange?.(navId)}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('text/home-nav-id', navId)
            e.dataTransfer.effectAllowed = 'move'
          }}
        >
          <span className="dc-nav-icon">
            {meta.icon ? (
              <img src={meta.icon} alt="" className="dc-nav-icon-img" draggable={false} />
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z" />
              </svg>
            )}
            {isMessages && totalUnreadMessages > 0 && (
              <span
                className="dc-icon-unread-badge"
                aria-label={`${totalUnreadMessages} unread messages`}
              >
                {totalUnreadMessages > 99 ? '99+' : totalUnreadMessages}
              </span>
            )}
          </span>
          <span className="dc-nav-label">{meta.label}</span>
          {isFriends && pendingFriendCount > 0 && (
            <span className="dc-nav-badge" aria-label={`${pendingFriendCount} pending friend requests`}>
              {pendingFriendCount}
            </span>
          )}
        </button>
        {isMessages && (
          <CreateMessageButton onClick={openCreateMessage} className="dc-create-msg-inline" />
        )}
        {isFriends && (
          <AddFriendButton
            onClick={(e) => {
              e.stopPropagation()
              onOpenAddFriend?.()
            }}
            className="dc-add-friend-inline"
          />
        )}
      </div>
    )
  }

  const renderPendingRequestRow = (req, index) => (
    <li
      key={req.id}
      className={`dc-pending-request-row ${pendingDragOverIndex === index ? 'drag-over' : ''}`}
      draggable
      onDragStart={() => setPendingDragIndex(index)}
      onDragEnd={() => { setPendingDragIndex(null); setPendingDragOverIndex(null) }}
      onDragOver={(e) => { e.preventDefault(); setPendingDragOverIndex(index) }}
      onDrop={(e) => {
        e.preventDefault()
        if (pendingDragIndex != null) reorderPending(pendingDragIndex, index)
        setPendingDragIndex(null)
        setPendingDragOverIndex(null)
      }}
    >
      <span className="dc-pending-drag-handle" aria-hidden="true" title="Drag to reorder">⋮⋮</span>
      <DmAvatar name={req.fromUsername} color={req.avatar || '#5865f2'} status="online" />
      <span className="dc-dm-meta">
        <span className="dc-dm-name">{req.fromUsername}</span>
        <span className="dc-dm-activity">Incoming friend request</span>
      </span>
      <div className="dc-pending-actions">
        <button
          type="button"
          className="dc-pending-accept"
          onClick={() => onAcceptFriendRequest?.(req.id)}
        >
          Accept
        </button>
        <button
          type="button"
          className="dc-pending-decline"
          onClick={() => onDeclineFriendRequest?.(req.id)}
        >
          Decline
        </button>
      </div>
    </li>
  )

  const renderOutgoingRequestRow = (req) => (
    <li key={req.id} className="dc-pending-request-row dc-outgoing-request-row">
      <DmAvatar name={req.toUsername} color={req.avatar || '#5865f2'} status="offline" />
      <span className="dc-dm-meta">
        <span className="dc-dm-name">{req.toUsername}</span>
        <span className="dc-dm-activity">Request sent — waiting</span>
      </span>
      <div className="dc-pending-actions">
        <button
          type="button"
          className="dc-pending-decline"
          onClick={() => onCancelOutgoingFriendRequest?.(req.id)}
        >
          Cancel
        </button>
      </div>
    </li>
  )

  const renderFriendRow = (friend) => {
    const convId = String(friend.id)
    return (
    <li
      key={friend.id}
      className={rowClass(convId)}
      {...rowDragProps(convId)}
    >
      <button
        type="button"
        className={`dc-dm-item ${selectedFriendId === friend.id ? 'active' : ''}`}
        onClick={() => onSelectFriend?.(friend)}
        onContextMenu={(e) => {
          e.preventDefault()
          openDmMenu(e, 'friend', friend)
        }}
      >
        <DmAvatar name={friend.name} color={friend.avatar} status={friend.status || 'offline'} profile={friend.profile} resolveSrc={resolveAvatarSrc} />
        <span className="dc-dm-meta">
          <span className="dc-dm-name" style={friend.profile ? nameStyleToCss(friend.profile.nameStyle, friend.profile.nameFont) : undefined}>{friend.name}</span>
          {friend.profile?.tags?.length > 0 && (
            <span className="dc-dm-tags">{friend.profile.tags.map((t) => <span key={`${t.type}-${t.label}`} className={`profile-tag profile-tag-${t.type}`}>{t.label}</span>)}</span>
          )}
          {friend.activity && <span className="dc-dm-activity">{friend.activity}</span>}
        </span>
      </button>
    </li>
    )
  }

  const getUnread = (item) => {
    const id = String(item.id)
    return Number(
      item.unreadCount ?? unreadByChatId[id] ?? unreadByChatId[item.id] ?? groupUnread[id] ?? groupUnread[item.id] ?? 0
    ) || 0
  }

  const getLastActivity = (item) => {
    return Number(item.lastMessage?.createdAt || item.lastMessage?.ts || item.updatedAt || item.createdAt || 0) || 0
  }

  const sortByRecentActivity = (a, b) => {
    const activityDelta = getLastActivity(b) - getLastActivity(a)
    if (activityDelta !== 0) return activityDelta
    const unreadDelta = getUnread(b) - getUnread(a)
    if (unreadDelta !== 0) return unreadDelta
    return a.name.localeCompare(b.name)
  }

  const directMessageList = (() => {
    const base = dmConversations.length > 0 ? dmConversations : MOCK_DIRECT_MESSAGES
    return [...base]
      .map((dm) => ({
        ...dm,
        peerUsername: dm.peerUsername || dm.name,
        unreadCount: getUnread(dm),
      }))
      .sort(sortByRecentActivity)
  })()

  const groupMessageList = Array.isArray(groupConversations)
    ? [...groupConversations].sort(sortByRecentActivity)
    : [...MOCK_GROUP_MESSAGES].sort(sortByRecentActivity)

  // All draggable entities (DMs + groups + friends) keyed by id, for manual-ordered sections.
  const allConversations = useMemo(() => {
    const map = new Map()
    directMessageList.forEach((dm) => map.set(String(dm.id), { kind: 'dm', item: dm }))
    groupMessageList.forEach((g) => map.set(String(g.id), { kind: 'group', item: { ...g, unreadCount: groupUnread[g.id] || 0 } }))
    friends.forEach((f) => { if (!map.has(String(f.id))) map.set(String(f.id), { kind: 'friend', item: f }) })
    return map
  }, [directMessageList, groupMessageList, groupUnread, friends])

  // Conversations for a bucket in stored manual order (ordered ids first, then any leftovers).
  const conversationsForBucket = (bucketKey) => {
    const ids = dmOrder[bucketKey] || []
    const ordered = ids.map((id) => allConversations.get(String(id))).filter(Boolean)
    const inThisBucket = (id) => (bucketKey === '__unsorted' ? !dmSectionMap[id] : dmSectionMap[id] === bucketKey)
    // Append any conversation assigned to this bucket but missing from the order list.
    const extra = []
    allConversations.forEach((entry, id) => {
      if (inThisBucket(id) && !ids.includes(id)) extra.push(entry)
    })
    return [...ordered.filter((e) => inThisBucket(String(e.item.id))), ...extra]
  }

  // Search across DMs, groups, and friends for the dropdown results.
  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return []
    const seen = new Set()
    const out = []
    const add = (kind, item) => {
      const key = `${kind}-${item.id}`
      if (seen.has(key) || !item.name?.toLowerCase().includes(q)) return
      seen.add(key)
      out.push({ kind, item })
    }
    directMessageList.forEach((dm) => add('dm', dm))
    groupMessageList.forEach((g) => add('group', g))
    friends.forEach((f) => add('dm', { ...f, peerUsername: f.peerUsername || f.name }))
    return out.slice(0, 8)
  }, [search, directMessageList, groupMessageList, friends])

  const handleSearchSelect = (result) => {
    if (result.kind === 'group') onSelectGroup?.(result.item)
    else onSelectDm?.(result.item)
    setSearch('')
    setSearchFocused(false)
  }

  // Close the search dropdown when clicking outside it.
  useEffect(() => {
    if (!searchFocused) return undefined
    const onDown = (e) => {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target)) setSearchFocused(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [searchFocused])

  const renderMessageRow = (item, onClick, selected, kind = 'dm') => {
    const unread = getUnread(item)
    const preview = item.lastMessage?.text || item.activity || item.preview
    const convId = String(item.id)
    return (
      <li
        key={item.id}
        className={rowClass(convId)}
        {...rowDragProps(convId)}
      >
        <button
          type="button"
          className={`dc-dm-item ${selected ? 'active' : ''} ${unread > 0 ? 'has-unread' : ''}`}
          onClick={() => onClick?.(item)}
          onContextMenu={(e) => openDmMenu(e, kind, item)}
        >
          <DmAvatar
            name={item.name}
            color={item.avatar}
            status={item.status || 'online'}
            bot={item.bot}
            unreadCount={unread}
            profile={item.profile}
            resolveSrc={resolveAvatarSrc}
          />
          <span className="dc-dm-meta">
            <span className="dc-dm-name" style={item.profile ? nameStyleToCss(item.profile.nameStyle, item.profile.nameFont) : undefined}>{item.name}</span>
            {item.profile?.tags?.length > 0 && (
              <span className="dc-dm-tags">{item.profile.tags.map((t) => <span key={`${t.type}-${t.label}`} className={`profile-tag profile-tag-${t.type}`}>{t.label}</span>)}</span>
            )}
            {preview && <span className="dc-dm-activity">{preview}</span>}
          </span>
          {unread > 0 && (
            <span className="dc-dm-row-unread" aria-hidden="true">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
      </li>
    )
  }

  // Render any draggable entry (dm / group / friend) using the right row renderer.
  const renderEntry = (entry) => {
    if (entry.kind === 'group') return renderMessageRow(entry.item, onSelectGroup, selectedGroupId === entry.item.id, 'group')
    if (entry.kind === 'friend') return renderFriendRow(entry.item)
    return renderMessageRow(entry.item, onSelectDm, String(selectedDmId) === String(entry.item.id), 'dm')
  }

  // Render the user-created sections as drop targets (used in both Friends and Messages panels).
  const renderSections = () => {
    if (dmSections.length === 0) return null
    const dropOnBucket = (e, sectionId) => {
      e.preventDefault()
      if (!dragConvId) return
      moveConversationToSection(dragConvId, sectionId)
      setDragConvId(null)
    }
    return dmSections.map((section) => {
      const entries = conversationsForBucket(section.id)
      return (
        <div
          className="dc-msg-group"
          key={section.id}
          onDragOver={(e) => { if (dragConvId) e.preventDefault() }}
          onDrop={(e) => dropOnBucket(e, section.id)}
        >
          <div className="dc-msg-group-label dc-section-label">
            <span>{section.name}</span>
            <button type="button" className="dc-section-delete" onClick={() => deleteSection(section.id)} title="Delete section" aria-label={`Delete ${section.name}`}>✕</button>
          </div>
          <ul className="dc-dm-list dc-section-droplist">
            {entries.length === 0 ? (
              <li className="dc-friends-empty">Drag a person or chat here.</li>
            ) : entries.map(renderEntry)}
          </ul>
        </div>
      )
    })
  }

  const renderContent = () => {
    if (activeNav === 'friends') {
      return (
        <div className="dc-friends-panel">
          {outgoingFriendRequests.length > 0 && (
            <div className="dc-msg-group">
              <div className="dc-msg-group-label">Sent Friend Requests</div>
              <ul className="dc-dm-list dc-pending-requests-list">
                {outgoingFriendRequests.map(renderOutgoingRequestRow)}
              </ul>
            </div>
          )}
          {orderedPendingRequests.length > 0 && (
            <div className="dc-msg-group">
              <div className="dc-msg-group-label">Pending Friend Requests</div>
              <ul className="dc-dm-list dc-pending-requests-list">
                {orderedPendingRequests.map((req, index) => renderPendingRequestRow(req, index))}
              </ul>
            </div>
          )}
          {renderSections()}
          <div
            className="dc-msg-group"
            onDragOver={(e) => { if (dragConvId) e.preventDefault() }}
            onDrop={(e) => { e.preventDefault(); if (dragConvId) { moveConversationToSection(dragConvId, null); setDragConvId(null) } }}
          >
            {dmSections.length > 0 && <div className="dc-msg-group-label">All Friends</div>}
            <ul className="dc-dm-list dc-home-content-list">
              {friends.length === 0 ? (
                <li className="dc-friends-empty">No friends yet — add someone with the + button.</li>
              ) : (
                friends.filter((f) => !dmSectionMap[f.id]).map(renderFriendRow)
              )}
            </ul>
          </div>
        </div>
      )
    }
    if (activeNav === 'messages') {
      // Drop onto a section header / empty area appends the dragged conversation to that bucket.
      const dropOnBucket = (e, bucketKey) => {
        e.preventDefault()
        if (!dragConvId) return
        const sectionId = bucketKey === UNSORTED ? null : bucketKey
        moveConversationToSection(dragConvId, sectionId)
        setDragConvId(null)
      }
      return (
        <div className="dc-messages-panel">
          {renderSections()}
          <div
            className="dc-msg-group"
            onDragOver={(e) => { if (dragConvId) e.preventDefault() }}
            onDrop={(e) => dropOnBucket(e, UNSORTED)}
          >
            <div className="dc-msg-group-label">Direct Messages</div>
            <ul className="dc-dm-list">
              {conversationsForBucket(UNSORTED).filter((e) => e.kind === 'dm').map(renderEntry)}
            </ul>
          </div>
          <div className="dc-msg-group">
            <div className="dc-msg-group-label">Group Messages</div>
            <ul className="dc-dm-list">
              {(() => {
                const groups = conversationsForBucket(UNSORTED).filter((e) => e.kind === 'group')
                return groups.length === 0
                  ? <li className="dc-friends-empty">No group chats yet.</li>
                  : groups.map(renderEntry)
              })()}
            </ul>
          </div>
        </div>
      )
    }
    return null
  }

  return (
    <>
      <div className="dc-search-wrap" ref={searchWrapRef}>
        <input
          type="text"
          className="dc-search"
          placeholder="Find or start a conversation"
          aria-label="Find or start a conversation"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onFocus={() => setSearchFocused(true)}
        />
        {searchFocused && search.trim() && (
          <div className="dc-search-results" role="listbox">
            {searchResults.length === 0 ? (
              <div className="dc-search-empty">No conversations found</div>
            ) : (
              searchResults.map((r) => (
                <button
                  key={`${r.kind}-${r.item.id}`}
                  type="button"
                  className="dc-search-result"
                  role="option"
                  onClick={() => handleSearchSelect(r)}
                >
                  <DmAvatar name={r.item.name} color={r.item.avatar} status={r.item.status || 'online'} bot={r.item.bot} profile={r.item.profile} resolveSrc={resolveAvatarSrc} />
                  <span className="dc-search-result-meta">
                    <span className="dc-search-result-name" style={r.item.profile ? nameStyleToCss(r.item.profile.nameStyle, r.item.profile.nameFont) : undefined}>{r.item.name}</span>
                    <span className="dc-search-result-kind">{r.kind === 'group' ? 'Group' : 'Direct Message'}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      <div className="dc-home-layout">
        {layoutNavEntries.map(({ item, index }) => (
          <div
            key={item.id}
            className={`dc-home-layout-item ${dragOverIndex === index ? 'drag-over' : ''}`}
            draggable
            onDragStart={() => setDragIndex(index)}
            onDragEnd={() => { setDragIndex(null); setDragOverIndex(null) }}
            onDragOver={(e) => { e.preventDefault(); setDragOverIndex(index) }}
            onDrop={(e) => {
              e.preventDefault()
              const navId = e.dataTransfer.getData('text/home-nav-id')
              if (navId && dragIndex != null) reorderTopLevel(dragIndex, index)
              setDragIndex(null)
              setDragOverIndex(null)
            }}
          >
            {renderNavButton(item.id)}
          </div>
        ))}

        <button type="button" className="dc-add-section-btn" onClick={createConversationSection}>
          + Create Section
        </button>
      </div>

      <div className="dc-home-content">{renderContent()}</div>

      {dmMenu && (
        <div
          className="dc-context-menu"
          style={{ left: dmMenu.x, top: dmMenu.y }}
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="dc-context-menu-label">Move to section</div>
          {dmSections.map((section) => (
            <button
              key={section.id}
              type="button"
              role="menuitem"
              onClick={() => moveConversationToSection(dmMenu.id, section.id)}
            >
              {dmSectionMap[dmMenu.id] === section.id ? '✓ ' : ''}{section.name}
            </button>
          ))}
          {dmSectionMap[dmMenu.id] && (
            <button type="button" role="menuitem" onClick={() => moveConversationToSection(dmMenu.id, null)}>
              Remove from section
            </button>
          )}
          <button type="button" role="menuitem" className="dc-context-menu-accent" onClick={() => createDmSectionAndMove(dmMenu.id)}>
            + New section…
          </button>
        </div>
      )}

      {contextMenu && (
        <div
          className="dc-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onFriendViewProfile?.(contextMenu.friend)
              setContextMenu(null)
            }}
          >
            View Profile
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onFriendVoiceChat?.(contextMenu.friend)
              setContextMenu(null)
            }}
          >
            Voice Chat
          </button>
        </div>
      )}
    </>
  )
}
