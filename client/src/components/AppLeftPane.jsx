import React, { useRef, useState, useCallback, useEffect } from 'react'
import longPressProps from '../longPress'
import HomeLeftPanel from './HomeLeftPanel'
import FloatingMenu from './FloatingMenu'
import MemberActionItems from './MemberActionItems'
import ChannelList from './ChannelList'
import { effectivePermissions, memberActionsFor, NO_MEMBER_ACTIONS } from '../permissions'
import { formatMoment } from '../moderation'
import ProfileAvatar from './ProfileAvatar'
import { nameStyleToCss } from '../profileData'

// Rail tile colors are assigned by position (stable per server list order).
const SERVER_COLORS = ['#5865f2', '#3ba55c', '#faa61a', '#eb459e', '#57f287', '#e0574d', '#29b6f6', '#7e57c2']
const serverInitials = (name) => ((name || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?')

const STATUS_OPTIONS = [
  { id: 'available', label: 'Available' },
  { id: 'busy', label: 'Busy' },
  { id: 'away', label: 'Away' },
  { id: 'offline', label: 'Offline' },
]

// Icons live in public/icons; prefix with the app's base path (e.g. /app/) so they resolve
// wherever the app is mounted.
const ICON_BASE = import.meta.env.BASE_URL + 'icons/'
const HOME_ICON_URL = ICON_BASE + 'home.png'
const MICROPHONE_ICON_URL = ICON_BASE + 'microphone.png'
const HEADPHONES_ICON_URL = ICON_BASE + 'headphones.png'
const ADD_SERVER_ICON_URL = ICON_BASE + 'add-server.png'
const DOWNLOAD_APPS_ICON_URL = ICON_BASE + 'download-apps.png'

const SPEAKER_ICON_PATH = 'M12 3a9 9 0 0 0-9 9v3a3 3 0 0 0 3 3h1v-6H6a7 7 0 0 1 14 0v6h1a3 3 0 0 0 3-3v-3a9 9 0 0 0-9-9Zm-1 14h2v3h-2v-3Z'

// Cogwheel for the settings button. The asset it replaced (icons/settings.png) was a person
// silhouette, so the button read as "my profile" when it opens settings for the whole app. Inline SVG
// rather than another PNG: it stays crisp at any size and inherits the control's colour states.
function CogIcon() {
  return (
    <svg className="dc-control-icon dc-settings-icon" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
        <rect key={deg} x="10.8" y="1.4" width="2.4" height="5" rx="1" transform={`rotate(${deg} 12 12)`} />
      ))}
      {/* evenodd so the centre is punched out rather than painted with a background colour. */}
      <path fillRule="evenodd" d="M12 5a7 7 0 1 0 0 14 7 7 0 1 0 0-14Zm0 3.9a3.1 3.1 0 1 0 0 6.2 3.1 3.1 0 1 0 0-6.2Z" />
    </svg>
  )
}

function RailSpeakerIcon() {
  return (
    <svg className="dc-rail-speaker-icon" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={SPEAKER_ICON_PATH} />
    </svg>
  )
}

function VoiceTileScrim() {
  return (
    <div className="dc-voice-tile-overlay" aria-hidden="true">
      <div className="dc-voice-overlay-scrim" />
      <RailSpeakerIcon />
    </div>
  )
}

function VoiceTileControls({ micMuted, deafened, onToggleMic, onToggleDeafen }) {
  return (
    <div className="dc-voice-tile-controls" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`dc-control-btn dc-voice-tile-btn ${micMuted ? 'active' : ''}`}
        title={micMuted ? 'Unmute' : 'Mute'}
        onClick={onToggleMic}
      >
        <img src={MICROPHONE_ICON_URL} alt="" className="dc-control-icon dc-microphone-icon" draggable={false} />
      </button>
      <button
        type="button"
        className={`dc-control-btn dc-voice-tile-btn ${deafened ? 'active' : ''}`}
        title={deafened ? 'Undeafen' : 'Deafen'}
        onClick={onToggleDeafen}
      >
        <img src={HEADPHONES_ICON_URL} alt="" className="dc-control-icon dc-headphones-icon" draggable={false} />
      </button>
    </div>
  )
}

function RailIcon({
  children,
  title,
  active,
  onClick,
  onContextMenu,
  longPress,   // touch equivalent of onContextMenu (see longPress.js); spread onto the button
  badge,
  mentions = 0,
  className = '',
  home = false,
  voiceActive = false,
  voiceTileRef,
  onVoiceTileEnter,
  onVoiceTileLeave,
}) {
  return (
    <div
      ref={voiceActive ? voiceTileRef : null}
      className={`dc-rail-item-wrap ${active ? 'active' : ''} ${home ? 'dc-home-wrap' : ''} ${voiceActive ? 'dc-rail-in-voice' : ''} ${className}`}
      onMouseEnter={voiceActive ? onVoiceTileEnter : undefined}
      onMouseLeave={voiceActive ? onVoiceTileLeave : undefined}
    >
      {active && <span className="dc-rail-pill" aria-hidden="true" />}
      <button type="button" className={`dc-rail-item ${className}`} title={title} onClick={onClick} onContextMenu={onContextMenu} {...(longPress || {})}>
        {children}
        {voiceActive && <VoiceTileScrim />}
      </button>
      {/* Badge lives outside the (overflow-hidden) tile so it can sit over the top-right corner. */}
      {/* Mentions outrank the plain unread count: "someone named you" is the one a person acts on. */}
      {mentions > 0 ? (
        <span className="dc-rail-badge dc-rail-badge-mention" title={`${mentions} mention${mentions === 1 ? '' : 's'}`}>@{mentions > 99 ? '99+' : mentions}</span>
      ) : badge != null && badge > 0 && (
        <span className="dc-rail-badge">{badge > 99 ? '99+' : badge}</span>
      )}
    </div>
  )
}

function DmAvatar({ name, color, status, bot }) {
  const initial = (name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?'
  return (
    <div className="dc-dm-avatar-wrap">
      <div className="dc-dm-avatar" style={{ background: color }}>
        {initial}
      </div>
      <span className={`dc-status-ring dc-status-${status}`} aria-hidden="true" />
      {bot && <span className="dc-bot-tag">BOT</span>}
    </div>
  )
}

export default function AppLeftPane({
  displayName = 'Guest',
  profile = null,
  resolveAvatarSrc = (u) => u,
  onOpenAppDirectory,
  appReviewCount = 0,
  onOpenDiscover,
  liveCount = 0,
  connected = false,
  inVoice = false,
  voiceRailTarget = null,
  micMuted,
  deafened,
  onToggleMic,
  onToggleDeafen,
  onOpenSettings,
  userStatus = 'available',
  showStatusMenu = false,
  onToggleStatusMenu,
  onSelectStatus,
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
  onViewProfile,
  onRemoveFriend,
  onLeaveGroup,
  askPrompt,
  savedHomeLayout,
  onHomeLayoutChange,
  friends = [],
  pendingFriendRequests = [],
  pendingFriendCount = 0,
  onOpenAddFriend,
  onAcceptFriendRequest,
  onDeclineFriendRequest,
  outgoingFriendRequests = [],
  onCancelOutgoingFriendRequest,
  dmConversations = [],
  groupConversations = [],
  totalUnreadMessages = 0,
  unreadByChatId = {},
  groupUnread = {},
  selectedServerId = 'home',
  onSelectServer,
  variant = 'home',
  serverName = 'LAN Party',
  servers = [],
  channels = [],
  serverId = null,
  onCreateServer,
  onCreateChannel,
  onRenameServer,
  onDeleteServer,
  onResetAppRooms,        // (serverId, serverName) => void — owner/admins; asks before it does anything
  onRenameChannel,
  onDeleteChannel,
  onManageAccess,
  activeChannel,
  onJoinChannel,
  voiceChannelId = null,
  voiceServerId = null,
  onJoinVoice,
  onLeaveVoice,
  members = [],
  socketId,
  onSelectMember,
  myRole = 'member',
  serverOwner = null,
  currentUsername = null,
  onInviteServer,
  onLeaveServer,
  onKickMember,
  onSetMemberRole,
  channelUnreads = {},
  serverUnreadTotals = {},
  channelMentions = {},      // { channelId: count } of unread messages naming me, for the server on screen
  serverMentionTotals = {},  // { serverId: count }
  paneTab = 'channels',   // which view the server side panel is showing: 'channels' | 'members'
  onPaneTabChange,
  homeTileUrl = null,     // custom Home tile image (per-user); null = the default house icon
  resolveTileSrc = (u) => u,
  onChangeTileImage,      // (target) => void, where target is { kind: 'home' } | { kind: 'server', id, name }
  onResetTileImage,
  onPrivateMessage,       // ({ username, name }) => void — opens the compose modal
  // Moderation and blocking. Each handler asks first (or opens a dialog); the server decides.
  onTimeoutMember,        // (username) => void — owner/admins: opens the "Time out…" dialog
  onLiftMemberTimeout,    // (username) => void
  onBanMember,            // (username) => void — opens the "Ban…" dialog
  onBlockUser,            // (username) => void
  onUnblockUser,          // (username) => void
  blockedNames = new Set(), // usernames the signed-in person has blocked
  onOpenBans,             // (serverId, serverName) => void — people with the ban permission
  onOpenAuditLog,         // (serverId, serverName) => void — people with view_audit_log
  // Roles and categories. What the viewer may do is the server's word (server:state); here it
  // only decides which controls are drawn. The server refuses anything else, whatever is shown.
  myPermissions = new Set(), // what I may do in the server on screen (permissions.ts)
  viewer = null,          // { username, role, roles } — me, in the server on screen
  serverRoles = [],       // the server's custom roles, highest first
  categories = [],        // the channel categories I am shown
  onCreateCategory,       // () => void — asks for a name
  onRenameCategory,       // (categoryId, name) => void
  onDeleteCategory,       // (categoryId, name) => void — asks first
  onMoveCategory,         // (categoryId, 'up' | 'down') => void
  onMoveChannel,          // (channelId, 'up' | 'down') => void
  onSetChannelCategory,   // (channelId, categoryId | null) => void
  onOpenServerSettings,   // (serverId, serverName) => void — any member; opens on Roles
  onToggleMemberRole,     // (username, roleId, on) => void
}) {
  // Channels: anyone may add one in the public commons; elsewhere it takes manage_channels.
  // Categories and channel order exist in real servers only.
  const canManageChannels = serverId === 'demo' || myPermissions.has('manage_channels')
  const canArrangeChannels = serverId !== 'demo' && myPermissions.has('manage_channels')
  const showMembersTab = paneTab === 'members'
  const showVoiceOnHome = inVoice && voiceRailTarget === 'home'
  // Right-click context menu for server tiles / channel rows: { x, y, kind, id, name, isDefault }.
  const [ctxMenu, setCtxMenu] = useState(null)
  // Whether the channel menu's "Move to category" list is open. It unfolds inside the menu
  // rather than flying out beside it: a fly-out has nowhere to go on a phone.
  const [ctxSubOpen, setCtxSubOpen] = useState(false)
  const ctxMenuRef = useRef(null)
  useEffect(() => {
    if (!ctxMenu) return
    const close = (e) => { if (!ctxMenuRef.current || !ctxMenuRef.current.contains(e.target)) setCtxMenu(null) }
    const onKey = (e) => { if (e.key === 'Escape') setCtxMenu(null) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', onKey) }
  }, [ctxMenu])
  const openCtxMenu = (e, item) => {
    e.preventDefault()
    setCtxSubOpen(false)
    setCtxMenu({ x: Math.min(e.clientX, window.innerWidth - 180), y: Math.min(e.clientY, window.innerHeight - 110), ...item })
  }
  // What the server menu needs to know about a server (its right-click menu and the header dropdown).
  // `permissions` is what GET /servers says I may do there; for the server on screen the live
  // answer from server:state is used instead (it changes the moment a role does).
  const serverMenuItem = (s) => ({ kind: 'server', id: s.id, name: s.name, isDefault: s.id === 'demo', role: s.role || 'member', owner: s.owner || null, hasIcon: !!s.iconUrl, permissions: Array.isArray(s.permissions) ? s.permissions : null })
  const permissionsInServer = (item) => (variant === 'server' && item.id === serverId ? myPermissions : effectivePermissions(item.role, item.permissions))
  // The server-name header opens the same menu as right-clicking the server's tile, just below itself.
  const openServerHeaderMenu = (e) => {
    const s = servers.find((sv) => sv.id === selectedServerId)
    if (!s) return
    const r = e.currentTarget.getBoundingClientRect()
    openCtxMenu({ preventDefault() {}, clientX: r.left + 8, clientY: r.bottom + 4 }, serverMenuItem(s))
  }
  // Close the status dropdown (Available/Busy/…) on an outside click or Escape. The menu + its
  // trigger button live inside userPanelRef, so clicking the trigger just toggles (its own handler)
  // rather than double-firing here.
  const userPanelRef = useRef(null)
  useEffect(() => {
    if (!showStatusMenu) return
    const close = (e) => { if (!userPanelRef.current || !userPanelRef.current.contains(e.target)) onToggleStatusMenu?.() }
    const onKey = (e) => { if (e.key === 'Escape') onToggleStatusMenu?.() }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', onKey) }
  }, [showStatusMenu, onToggleStatusMenu])
  const dcLeftRef = useRef(null)
  const voiceTileRef = useRef(null)
  const [voiceControlsHover, setVoiceControlsHover] = useState(false)
  const [voiceControlsTop, setVoiceControlsTop] = useState(0)

  const updateVoiceControlsPosition = useCallback(() => {
    if (!voiceTileRef.current || !dcLeftRef.current) return
    const tile = voiceTileRef.current.getBoundingClientRect()
    const panel = dcLeftRef.current.getBoundingClientRect()
    setVoiceControlsTop(tile.top - panel.top + tile.height / 2)
  }, [])

  const handleVoiceTileEnter = useCallback(() => {
    updateVoiceControlsPosition()
    setVoiceControlsHover(true)
  }, [updateVoiceControlsPosition])

  const handleVoiceTileLeave = useCallback(() => {
    setVoiceControlsHover(false)
  }, [])

  useEffect(() => {
    if (!inVoice || !voiceControlsHover) return undefined
    const rail = dcLeftRef.current?.querySelector('.dc-server-rail')
    const onScroll = () => updateVoiceControlsPosition()
    rail?.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      rail?.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [inVoice, voiceControlsHover, updateVoiceControlsPosition])

  const voiceTileProps = {
    voiceTileRef,
    onVoiceTileEnter: handleVoiceTileEnter,
    onVoiceTileLeave: handleVoiceTileLeave,
  }

  return (
    <aside ref={dcLeftRef} className="dc-left" aria-label="Navigation">
      <div className="dc-server-rail">
        <RailIcon
          title={homeTileUrl ? 'Home — right-click to change the tile image' : 'Home'}
          home
          active={selectedServerId === 'home'}
          voiceActive={showVoiceOnHome}
          badge={selectedServerId === 'home' ? 0 : totalUnreadMessages}
          onClick={() => onSelectServer?.('home')}
          onContextMenu={(e) => openCtxMenu(e, { kind: 'home', hasIcon: !!homeTileUrl })}
          longPress={longPressProps((e) => openCtxMenu(e, { kind: 'home', hasIcon: !!homeTileUrl }))}
          {...voiceTileProps}
        >
          {/* A custom tile is cropped square on upload, so it only needs covering the tile. */}
          <img
            src={homeTileUrl ? resolveTileSrc(homeTileUrl) : HOME_ICON_URL}
            alt=""
            className={`dc-home-img ${homeTileUrl ? 'dc-tile-custom' : ''}`}
            draggable={false}
            width={48}
            height={48}
          />
        </RailIcon>

        <div className="dc-rail-separator" />

        {servers.map((s, i) => (
          <RailIcon
            key={s.id}
            title={s.name}
            active={selectedServerId === s.id}
            voiceActive={inVoice && voiceRailTarget === s.id}
            badge={serverUnreadTotals[s.id] || 0}
            mentions={serverMentionTotals[s.id] || 0}
            onClick={() => onSelectServer?.(s.id)}
            onContextMenu={(e) => openCtxMenu(e, serverMenuItem(s))}
            longPress={longPressProps((e) => openCtxMenu(e, serverMenuItem(s)))}
            {...voiceTileProps}
          >
            {/* A server icon is shared by every member; without one the tile falls back to initials. */}
            {s.iconUrl ? (
              <img src={resolveTileSrc(s.iconUrl)} alt="" className="dc-server-icon dc-tile-custom" draggable={false} />
            ) : (
              <span className="dc-server-icon" style={{ background: SERVER_COLORS[i % SERVER_COLORS.length] }}>
                {serverInitials(s.name)}
              </span>
            )}
          </RailIcon>
        ))}

        <div className="dc-rail-spacer" />

        <RailIcon title="Add a Server" className="dc-rail-action" onClick={onCreateServer}>
          <img src={ADD_SERVER_ICON_URL} alt="" className="dc-rail-action-img dc-add-server-img" draggable={false} />
        </RailIcon>
        {/* The badge is only ever non-zero for an instance owner: apps waiting for their review. */}
        <RailIcon title={appReviewCount > 0 ? `Download / Upload Apps — ${appReviewCount} waiting for review` : 'Download / Upload Apps'} className="dc-rail-action" onClick={onOpenAppDirectory} badge={appReviewCount}>
          <img src={DOWNLOAD_APPS_ICON_URL} alt="" className="dc-rail-action-img dc-download-apps-img" draggable={false} />
        </RailIcon>
        <RailIcon title="Discover live streams" className="dc-rail-action" onClick={onOpenDiscover} badge={liveCount}>
          <span className="dc-rail-discover" aria-hidden="true">📡</span>
        </RailIcon>
      </div>

      <div className="dc-guild-nav">
        <div className="dc-guild-nav-scroll">
          {variant === 'server' ? (
            <>
              <div className="dc-server-header">
                <button type="button" className="dc-server-header-btn" aria-haspopup="menu" aria-expanded={ctxMenu?.kind === 'server' && ctxMenu.id === selectedServerId} onClick={openServerHeaderMenu}>
                  <span>{serverName}</span>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M7 10l5 5 5-5H7z" />
                  </svg>
                </button>
              </div>
              {/* One side panel, two views. The member list used to live in a right-side slide-over,
                  which put it far from the channels it belongs with and made it easy to miss. */}
              <div className="dc-pane-tabs" role="tablist" aria-label="Server panel">
                <button
                  type="button"
                  role="tab"
                  aria-selected={!showMembersTab}
                  className={`dc-pane-tab ${!showMembersTab ? 'active' : ''}`}
                  onClick={() => onPaneTabChange?.('channels')}
                >
                  Channels
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={showMembersTab}
                  className={`dc-pane-tab ${showMembersTab ? 'active' : ''}`}
                  onClick={() => onPaneTabChange?.('members')}
                >
                  Members
                  {members.length > 0 && <span className="dc-pane-tab-count">{members.length}</span>}
                </button>
              </div>

              {showMembersTab ? (
                <div className="dc-members-section">
                  {myPermissions.has('invite') && serverId !== 'demo' && (
                    <button type="button" className="dc-members-invite" onClick={() => onInviteServer?.(serverId, serverName)}>
                      + Invite people
                    </button>
                  )}
                  {members.length === 0 ? (
                    <div className="dc-members-empty">No members yet.</div>
                  ) : (
                    <ul className="dc-members-list">
                      {members.map((m) => {
                        const role = m.role || 'member'
                        // Anyone can privately message anyone else here, so the menu opens for every
                        // member but yourself — it used to open only for staff, which would have left
                        // ordinary members with no way to reach it. The manage entries in it are
                        // worked out when it is drawn, from what the viewer may do to this member.
                        const hasMenu = Boolean(m.username) && !m.isYou
                        const openMemberMenu = (e) => openCtxMenu(e, { kind: 'member', id: m.id, name: m.name, username: m.username, role, timedOut: Boolean(m.timeoutUntil) })
                        return (
                          <li key={m.id}>
                            <button
                              type="button"
                              className="dc-member-row"
                              onClick={() => m.username && onSelectMember?.(m.username)}
                              onContextMenu={hasMenu ? openMemberMenu : undefined}
                              {...(hasMenu ? longPressProps(openMemberMenu) : {})}
                              title={m.username ? `View ${m.name}'s profile${hasMenu ? ' — right-click for more' : ''}` : undefined}
                            >
                              <span className={`dc-member-dot ${m.online === false ? 'offline' : ''}`} />
                              {/* In the colour of their highest coloured role, if they have one. */}
                              <span className="dc-member-name" style={m.color ? { color: m.color } : undefined}>{m.name}{m.isYou ? ' (you)' : ''}</span>
                              {/* Timed out here: shown to everyone, and gone the moment it ends. */}
                              {m.timeoutUntil && <span className="dc-member-timeout" title={`Timed out until ${formatMoment(m.timeoutUntil)}`} aria-label={`Timed out until ${formatMoment(m.timeoutUntil)}`}>⏳</span>}
                              {role === 'owner' && <span className="dc-member-role owner" title="Owner">👑</span>}
                              {role === 'admin' && <span className="dc-member-role admin" title="Admin">🛡️</span>}
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              ) : (
              <ChannelList
                channels={channels}
                categories={categories}
                serverId={serverId}
                activeChannel={activeChannel}
                channelUnreads={channelUnreads}
                channelMentions={channelMentions}
                canManage={canManageChannels}
                collapseKey={currentUsername || displayName || 'guest'}
                inVoice={inVoice}
                voiceServerId={voiceServerId}
                voiceChannelId={voiceChannelId}
                onJoinChannel={onJoinChannel}
                onJoinVoice={onJoinVoice}
                onLeaveVoice={onLeaveVoice}
                onCreateChannel={onCreateChannel}
                onOpenMenu={openCtxMenu}
              />
              )}
            </>
          ) : (
            <HomeLeftPanel
              resolveAvatarSrc={resolveAvatarSrc}
              activeNav={activeNav}
              onNavChange={onNavChange}
              onSelectFriend={onSelectFriend}
              selectedFriendId={selectedFriendId}
              onSelectDm={onSelectDm}
              selectedDmId={selectedDmId}
              onSelectGroup={onSelectGroup}
              selectedGroupId={selectedGroupId}
              onCreateMessage={onCreateMessage}
              onFriendVoiceChat={onFriendVoiceChat}
              onViewProfile={onViewProfile}
              onRemoveFriend={onRemoveFriend}
              onLeaveGroup={onLeaveGroup}
              askPrompt={askPrompt}
              savedHomeLayout={savedHomeLayout}
              onHomeLayoutChange={onHomeLayoutChange}
              friends={friends}
              pendingFriendRequests={pendingFriendRequests}
              pendingFriendCount={pendingFriendCount}
              onOpenAddFriend={onOpenAddFriend}
              onAcceptFriendRequest={onAcceptFriendRequest}
              onDeclineFriendRequest={onDeclineFriendRequest}
              outgoingFriendRequests={outgoingFriendRequests}
              onCancelOutgoingFriendRequest={onCancelOutgoingFriendRequest}
              dmConversations={dmConversations}
              groupConversations={groupConversations}
              totalUnreadMessages={totalUnreadMessages}
              unreadByChatId={unreadByChatId}
              groupUnread={groupUnread}
            />
          )}
        </div>

        <div className="dc-user-panel" ref={userPanelRef}>
          {showStatusMenu && (
            <div className="dc-status-menu" role="menu" aria-label="Set status">
              {STATUS_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={userStatus === opt.id}
                  className={`dc-status-option ${userStatus === opt.id ? 'active' : ''}`}
                  onClick={() => onSelectStatus?.(opt.id)}
                >
                  <span className={`dc-status-dot dc-status-${opt.id}`} aria-hidden="true" />
                  <span>{opt.label}</span>
                </button>
              ))}
            </div>
          )}
          <button type="button" className="dc-user-profile" onClick={onToggleStatusMenu} aria-expanded={showStatusMenu} aria-haspopup="menu">
            <div className="dc-dm-avatar-wrap dc-user-avatar-wrap">
              <ProfileAvatar name={displayName} profile={profile || {}} size={36} resolveSrc={resolveAvatarSrc} />
              <span className={`dc-status-ring dc-status-${userStatus}`} />
            </div>
            <span className="dc-user-text">
              <span className="dc-user-name" style={profile ? nameStyleToCss(profile.nameStyle, profile.nameFont) : undefined}>{displayName || 'Guest'}</span>
              <span className="dc-user-status">
                {profile?.statusMessage || STATUS_OPTIONS.find((o) => o.id === userStatus)?.label || 'Available'}
              </span>
            </span>
          </button>
          <div className="dc-user-controls">
            <button type="button" className="dc-control-btn" title="Settings" aria-label="Settings" onClick={onOpenSettings}>
              <CogIcon />
            </button>
          </div>
        </div>
      </div>

      {inVoice && voiceRailTarget && (
        <div
          className={`dc-voice-controls-portal ${voiceControlsHover ? 'visible' : ''}`}
          style={{ top: voiceControlsTop }}
          onMouseEnter={handleVoiceTileEnter}
          onMouseLeave={handleVoiceTileLeave}
        >
          <VoiceTileControls
            micMuted={micMuted}
            deafened={deafened}
            onToggleMic={onToggleMic}
            onToggleDeafen={onToggleDeafen}
          />
        </div>
      )}

      {/* Right-click menu for servers / channels / members (portaled above everything). */}
      {/* FloatingMenu measures itself and moves back inside the window: these menus are tall enough
          now (moderation entries) that opening one near the bottom edge would otherwise cut it off. */}
      {ctxMenu && (
        <FloatingMenu x={ctxMenu.x} y={ctxMenu.y} className="dc-ctx-menu" menuRef={ctxMenuRef}>
          {ctxMenu.kind === 'server' && (() => {
            const role = ctxMenu.role || 'member'
            const isDemo = ctxMenu.isDefault
            // Each entry follows the permission its route asks for (server/services/permissions.js):
            // the owner and admins hold them all, a member the ones their roles give them.
            const may = isDemo ? new Set() : permissionsInServer(ctxMenu)
            const items = []
            if (may.has('manage_server')) {
              items.push(
                <button key="rename" type="button" role="menuitem" className="dc-ctx-item" onClick={() => { setCtxMenu(null); onRenameServer?.(ctxMenu.id, ctxMenu.name) }}>✏️ Rename server</button>
              )
            }
            if (may.has('invite')) {
              items.push(
                <button key="invite" type="button" role="menuitem" className="dc-ctx-item" onClick={() => { setCtxMenu(null); onInviteServer?.(ctxMenu.id, ctxMenu.name) }}>➕ Invite people</button>
              )
            }
            if (may.has('manage_server')) {
              items.push(
                // The icon is shared, so it takes manage_server to set it — and everyone in the server sees it.
                <button key="icon" type="button" role="menuitem" className="dc-ctx-item" onClick={() => { setCtxMenu(null); onChangeTileImage?.({ kind: 'server', id: ctxMenu.id, name: ctxMenu.name }) }}>
                  🖼️ {ctxMenu.hasIcon ? 'Change icon' : 'Set icon'}
                </button>
              )
              if (ctxMenu.hasIcon) {
                items.push(
                  <button key="icon-reset" type="button" role="menuitem" className="dc-ctx-item" onClick={() => { setCtxMenu(null); onResetTileImage?.({ kind: 'server', id: ctxMenu.id, name: ctxMenu.name }) }}>↩️ Reset icon</button>
                )
              }
            }
            if (!isDemo) {
              items.push(
                // For every member: the roles are what the member list shows them anyway, and the
                // dialog disables whatever they may not change.
                <button key="settings" type="button" role="menuitem" className="dc-ctx-item" onClick={() => { setCtxMenu(null); onOpenServerSettings?.(ctxMenu.id, ctxMenu.name) }}>⚙️ Server settings</button>
              )
            }
            // Categories belong to the channel list on screen, so this is only offered for that server.
            if (may.has('manage_channels') && variant === 'server' && ctxMenu.id === serverId) {
              items.push(
                <button key="category" type="button" role="menuitem" className="dc-ctx-item" onClick={() => { setCtxMenu(null); onCreateCategory?.() }}>📁 New category…</button>
              )
            }
            if (may.has('manage_server')) {
              // New room ids for every app in this server's voice channels. The "…" is a promise
              // that nothing happens yet: App asks first, and says what it ends.
              items.push(
                <button key="app-rooms" type="button" role="menuitem" className="dc-ctx-item" onClick={() => { setCtxMenu(null); onResetAppRooms?.(ctxMenu.id, ctxMenu.name) }}>🔄 Reset app rooms…</button>
              )
            }
            // Moderation records. Each opens a dialog; the server refuses both to anyone without
            // the permission, whatever this menu shows.
            if (may.has('ban')) {
              items.push(
                <button key="bans" type="button" role="menuitem" className="dc-ctx-item" onClick={() => { setCtxMenu(null); onOpenBans?.(ctxMenu.id, ctxMenu.name) }}>⛔ Bans</button>
              )
            }
            if (may.has('view_audit_log')) {
              items.push(
                <button key="audit" type="button" role="menuitem" className="dc-ctx-item" onClick={() => { setCtxMenu(null); onOpenAuditLog?.(ctxMenu.id, ctxMenu.name) }}>📜 Audit log</button>
              )
            }
            if (role !== 'owner' && !isDemo) {
              items.push(
                <button key="leave" type="button" role="menuitem" className="dc-ctx-item danger" onClick={() => { setCtxMenu(null); onLeaveServer?.(ctxMenu.id, ctxMenu.name) }}>🚪 Leave server</button>
              )
            }
            if (role === 'owner' && !isDemo) {
              items.push(
                <button key="delete" type="button" role="menuitem" className="dc-ctx-item danger" onClick={() => { setCtxMenu(null); onDeleteServer?.(ctxMenu.id, ctxMenu.name) }}>🗑️ Delete server</button>
              )
            }
            return (
              <>
                <div className="dc-ctx-title">{ctxMenu.name}{role !== 'member' ? ` · ${role}` : ''}</div>
                {items.length ? items : <div className="dc-ctx-empty">No actions available</div>}
              </>
            )
          })()}

          {ctxMenu.kind === 'home' && (
            <>
              <div className="dc-ctx-title">Home</div>
              {/* Personal: this image is only ever shown to you. */}
              <button type="button" role="menuitem" className="dc-ctx-item" onClick={() => { setCtxMenu(null); onChangeTileImage?.({ kind: 'home' }) }}>
                🖼️ {ctxMenu.hasIcon ? 'Change tile image' : 'Set tile image'}
              </button>
              {ctxMenu.hasIcon && (
                <button type="button" role="menuitem" className="dc-ctx-item" onClick={() => { setCtxMenu(null); onResetTileImage?.({ kind: 'home' }) }}>↩️ Reset to default</button>
              )}
            </>
          )}

          {/* Only opened for someone who manages channels (ChannelList): everything in it is theirs to use. */}
          {ctxMenu.kind === 'channel' && (
            <>
              <div className="dc-ctx-title">#{ctxMenu.name}</div>
              <button type="button" role="menuitem" className="dc-ctx-item" onClick={() => { setCtxMenu(null); onRenameChannel?.(ctxMenu.id, ctxMenu.name) }}>✏️ Rename</button>
              {ctxMenu.privacy === 'private' && canArrangeChannels && (
                <button type="button" role="menuitem" className="dc-ctx-item" onClick={() => { setCtxMenu(null); onManageAccess?.(ctxMenu.id, ctxMenu.name) }}>🔑 Manage access</button>
              )}
              {canArrangeChannels && (
                <>
                  <div className="dc-ctx-sep" role="separator" />
                  <button type="button" role="menuitem" className="dc-ctx-item" disabled={!ctxMenu.canUp} onClick={() => { setCtxMenu(null); onMoveChannel?.(ctxMenu.id, 'up') }}>⬆️ Move up</button>
                  <button type="button" role="menuitem" className="dc-ctx-item" disabled={!ctxMenu.canDown} onClick={() => { setCtxMenu(null); onMoveChannel?.(ctxMenu.id, 'down') }}>⬇️ Move down</button>
                  {/* Where it is filed only changes where it is listed: who can open it stays as it is. */}
                  {(categories.length > 0) && (
                    <button type="button" role="menuitem" className="dc-ctx-item" aria-expanded={ctxSubOpen} onClick={() => setCtxSubOpen((open) => !open)}>
                      📂 Move to category <span className="dc-ctx-caret" aria-hidden="true">{ctxSubOpen ? '▾' : '▸'}</span>
                    </button>
                  )}
                  {ctxSubOpen && (
                    <div className="dc-ctx-sub" role="group" aria-label="Move to category">
                      {categories.map((cat) => (
                        <button key={cat.id} type="button" role="menuitemradio" aria-checked={ctxMenu.categoryId === cat.id} className="dc-ctx-item dc-ctx-check" disabled={ctxMenu.categoryId === cat.id}
                          onClick={() => { setCtxMenu(null); onSetChannelCategory?.(ctxMenu.id, cat.id) }}>
                          <span className="dc-ctx-checkbox" aria-hidden="true">{ctxMenu.categoryId === cat.id ? '✓' : ''}</span>
                          <span className="dc-ctx-check-label">{cat.name}</span>
                        </button>
                      ))}
                      <button type="button" role="menuitemradio" aria-checked={!ctxMenu.categoryId} className="dc-ctx-item dc-ctx-check" disabled={!ctxMenu.categoryId}
                        onClick={() => { setCtxMenu(null); onSetChannelCategory?.(ctxMenu.id, null) }}>
                        <span className="dc-ctx-checkbox" aria-hidden="true">{!ctxMenu.categoryId ? '✓' : ''}</span>
                        <span className="dc-ctx-check-label">No category</span>
                      </button>
                    </div>
                  )}
                  <button type="button" role="menuitem" className="dc-ctx-item" onClick={() => { setCtxMenu(null); onCreateCategory?.() }}>📁 New category…</button>
                  <div className="dc-ctx-sep" role="separator" />
                </>
              )}
              <button type="button" role="menuitem" className="dc-ctx-item danger" onClick={() => { setCtxMenu(null); onDeleteChannel?.(ctxMenu.id, ctxMenu.name) }}>🗑️ Delete</button>
            </>
          )}

          {/* A category is a heading: none of these change who can open the channels under it. */}
          {ctxMenu.kind === 'category' && (
            <>
              <div className="dc-ctx-title">{ctxMenu.name}</div>
              <button type="button" role="menuitem" className="dc-ctx-item" onClick={() => { setCtxMenu(null); onCreateChannel?.('text', ctxMenu.id) }}>➕ New channel here</button>
              <button type="button" role="menuitem" className="dc-ctx-item" onClick={() => { setCtxMenu(null); onRenameCategory?.(ctxMenu.id, ctxMenu.name) }}>✏️ Rename</button>
              <button type="button" role="menuitem" className="dc-ctx-item" disabled={!ctxMenu.canUp} onClick={() => { setCtxMenu(null); onMoveCategory?.(ctxMenu.id, 'up') }}>⬆️ Move up</button>
              <button type="button" role="menuitem" className="dc-ctx-item" disabled={!ctxMenu.canDown} onClick={() => { setCtxMenu(null); onMoveCategory?.(ctxMenu.id, 'down') }}>⬇️ Move down</button>
              <button type="button" role="menuitem" className="dc-ctx-item" onClick={() => { setCtxMenu(null); onCreateCategory?.() }}>📁 New category…</button>
              <div className="dc-ctx-sep" role="separator" />
              <button type="button" role="menuitem" className="dc-ctx-item danger" onClick={() => { setCtxMenu(null); onDeleteCategory?.(ctxMenu.id, ctxMenu.name) }}>🗑️ Delete</button>
            </>
          )}

          {ctxMenu.kind === 'member' && (() => {
            // Worked out now, from the member as the server last described them: what I may do to
            // them (permissions.ts mirrors the server's rank rules) and the roles they hold.
            const target = members.find((m) => m.username === ctxMenu.username)
            const actions = serverId !== 'demo' && target ? memberActionsFor(viewer, myPermissions, target, serverRoles) : NO_MEMBER_ACTIONS
            return (
            <>
              <div className="dc-ctx-title">{ctxMenu.name}{ctxMenu.role !== 'member' ? ` · ${ctxMenu.role}` : ''}</div>
              {/* Not offered for someone you blocked: the server would refuse the message. */}
              {!blockedNames.has(ctxMenu.username) && (
                <button type="button" role="menuitem" className="dc-ctx-item" onClick={() => { setCtxMenu(null); onPrivateMessage?.({ username: ctxMenu.username, name: ctxMenu.name }) }}>✉️ Private message</button>
              )}
              {/* Only the owner hands out or takes back admin; no permission stands in for that. */}
              {serverId !== 'demo' && myRole === 'owner' && ctxMenu.role === 'member' && (
                <button type="button" role="menuitem" className="dc-ctx-item" onClick={() => { setCtxMenu(null); onSetMemberRole?.(ctxMenu.username, 'admin') }}>🛡️ Make admin</button>
              )}
              {serverId !== 'demo' && myRole === 'owner' && ctxMenu.role === 'admin' && (
                <button type="button" role="menuitem" className="dc-ctx-item" onClick={() => { setCtxMenu(null); onSetMemberRole?.(ctxMenu.username, 'member') }}>⬇️ Remove admin</button>
              )}
              {actions.kick && (
                <button type="button" role="menuitem" className="dc-ctx-item danger" onClick={() => { setCtxMenu(null); onKickMember?.(ctxMenu.username) }}>🚫 Remove from server</button>
              )}
              {/* Roles, Time out and Ban (each by its own permission) and Block (anyone). */}
              <MemberActionItems
                username={ctxMenu.username}
                actions={actions}
                heldRoleIds={target?.roles || []}
                onToggleRole={onToggleMemberRole}
                timedOut={Boolean(ctxMenu.timedOut)}
                blocked={blockedNames.has(ctxMenu.username)}
                onDone={() => setCtxMenu(null)}
                onTimeout={onTimeoutMember}
                onLiftTimeout={onLiftMemberTimeout}
                onBan={onBanMember}
                onBlock={onBlockUser}
                onUnblock={onUnblockUser}
              />
            </>
            )
          })()}

        </FloatingMenu>
      )}
    </aside>
  )
}
