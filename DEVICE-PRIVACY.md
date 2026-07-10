# Device Access & Privacy

**LAN Party** (the Communication Tool) can use your **camera**, **microphone**, **speakers/audio output**, and **screen** for voice and video calls. This document explains exactly what we access, when, and the guarantees we make to you.

## Our promise

- **We never access any device without your action.** The app only touches a device the moment *you* enable it (e.g. you click "Join Voice", "Turn on camera", or pick a microphone/speaker).
- **No background access.** When you are not in a call, the app holds **no** microphone, camera, or screen streams. Leaving a call fully releases every device.
- **Nothing is recorded or uploaded.** Your camera/mic audio and video are sent **peer‑to‑peer** to the other people in your call (encrypted in transit via WebRTC DTLS‑SRTP). We do **not** record, store, or send them to any server.
- **You are always in control.** Mute, deafen, turn the camera off, stop sharing, or leave the call at any time — each immediately stops the corresponding device.

## What we access, and exactly when

| Device | Accessed when | Released when |
| --- | --- | --- |
| **Microphone** | You click **Join Voice** (the browser prompts for permission the first time). | You **leave** the call. |
| **Camera** | You open the camera preview and click **Turn on camera**. | You turn the camera off or leave the call. |
| **Speakers / audio output** | Only to *play* other participants' audio while you're in a call, and to apply your chosen output device. | You leave the call. |
| **Screen** | You click **Share your screen** and choose what to share in the browser/OS picker. | You stop sharing or leave the call. |
| **Device list (names)** | Only while a device picker (camera/mic/speaker) is open, so we can show you the options. Device *labels* are only revealed by the browser after you've granted permission. | — |

## Choosing your devices

- **Microphone:** the caret (▾) next to the mute button lets you pick which mic to speak through. Switching re‑requests only that microphone.
- **Speaker / output:** the same menu lets you choose where you hear others (where your browser supports output selection).
- **Camera:** the "Turn on camera" preview lets you pick which camera to use and preview background effects **before** any video is sent to anyone.

## Background effects

Blur, background covers, and "Hide me" are applied **on your device** before your video leaves your computer. The processing runs locally in your browser. (The one‑time model download for segmentation is fetched from a public CDN; no video ever leaves your machine for it.)

## Your consent

By enabling a device in the app you consent to the app using **that device** for the duration described above. You can revoke access at any time through your browser's site settings, and the app will stop working with that device until you re‑enable it.

_Last updated: 2026‑07‑06 · The Jump Vault — thejumpvault.com_
