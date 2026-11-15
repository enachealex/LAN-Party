interface LinkPreviewSettingProps {
  show: boolean
  onChange: (show: boolean) => void
}

/**
 * The "Show link previews" switch in Settings → Messages. It hides the cards on this device only;
 * it uses the same switch as the sound setting next door, so nothing new had to be styled.
 */
export default function LinkPreviewSetting({ show, onChange }: LinkPreviewSettingProps) {
  return (
    <>
      <h3 className="profile-settings-section-title" style={{ marginTop: 24 }}>Link Previews</h3>
      <p className="profile-settings-note">Show a small card (title, description and image) under messages that contain a link. Turning this off hides the cards on this device only; the links themselves are unchanged.</p>
      <div className="sound-settings-row">
        <button type="button" className={`sound-toggle${show ? ' on' : ''}`} onClick={() => onChange(!show)} role="switch" aria-checked={show}>
          <span className="sound-toggle-track"><span className="sound-toggle-knob" /></span>
          <span className="sound-toggle-label">Show link previews</span>
        </button>
      </div>
    </>
  )
}
