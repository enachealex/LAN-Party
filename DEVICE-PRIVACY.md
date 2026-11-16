# Device Access & Privacy

**LAN Party** (the Communication Tool) can use your **camera**, **microphone**, **speakers/audio output**, and **screen** for voice and video calls. This document explains exactly what we access, when, and the guarantees we make to you.

## Our promise

- **We never access any device without your action.** The app only touches a device the moment *you* enable it (e.g. you click "Join Voice", "Turn on camera", or pick a microphone/speaker).
- **No background access.** When you are not in a call, the app holds **no** microphone, camera, or screen streams. Leaving a call fully releases every device.
- **Calls are never recorded.** Your audio and video normally travel through LAN Party's own call server, which forwards each stream to the other people in your call. If that server can't be reached, they go directly between the people in the call (peer‑to‑peer) instead, and when two networks can't reach each other directly, through LAN Party's own relay server. Either way they are encrypted in transit (WebRTC DTLS‑SRTP), and the relay only ever sees the encrypted stream. The call server only passes media along while you're connected: it does **not** record, store, or send it anywhere else.
- **You are always in control.** Mute, deafen, turn the camera off, stop sharing, or leave the call at any time — each immediately stops the corresponding device.

## What we access, and exactly when

| Device | Accessed when | Released when |
| --- | --- | --- |
| **Microphone** | You click **Join Voice** (the browser prompts for permission the first time). | You **leave** the call. |
| **Camera** | You open the camera preview and click **Turn on camera**. | You turn the camera off or leave the call. |
| **Speakers / audio output** | Only to *play* other participants' audio while you're in a call, and to apply your chosen output device. | You leave the call. |
| **Screen** | You click **Share your screen** and choose exactly what to share: in the browser's own picker, or in the Windows app, in LAN Party's picker (a whole screen or a single app window). Nothing is shared if you cancel. | You stop sharing or leave the call. |
| **Device list (names)** | Only while a device picker (camera/mic/speaker) is open, so we can show you the options. Device *labels* are only revealed by the browser after you've granted permission. | — |

## Choosing your devices

- **Microphone:** the caret (▾) next to the mute button lets you pick which mic to speak through. Switching re‑requests only that microphone.
- **Speaker / output:** the same menu lets you choose where you hear others (where your browser supports output selection).
- **Camera:** the "Turn on camera" preview lets you pick which camera to use and preview background effects **before** any video is sent to anyone.

## Background effects

Blur, background covers, and "Hide me" are applied **on your device** before your video leaves your computer. The processing runs locally in your browser. The segmentation model it uses is downloaded once from LAN Party itself (no third‑party service is involved), and no video is ever sent anywhere for it.

## The Windows app

The Windows app shows the same LAN Party as the website and asks for the same devices, under the same rules. Two differences:

- If you choose **Run in background** (on by default, in the tray icon's menu), closing the window keeps LAN Party running in the system tray, so **a call you're in keeps going** until you leave it. A small floating window shows the call's video while the main window is hidden. When you're not in a call, the tray app holds no devices.
- Screen sharing uses LAN Party's own picker, described above.

## Link previews

When someone posts a link, LAN Party's server — not your device — fetches that page once to show a small preview (title, description, picture). The linked site sees a request from LAN Party's server, never from you, and the preview picture is passed on by LAN Party so your device never contacts the linked site either. Only public websites are ever fetched. You can hide previews on your device in **Settings → Messages → Show link previews**, and whoever posted a link can remove its preview.

## Your consent

By enabling a device in the app you consent to the app using **that device** for the duration described above. You can revoke access at any time through your browser's site settings, and the app will stop working with that device until you re‑enable it.

_Last updated: 2026‑11‑15 · The Jump Vault — thejumpvault.com_
