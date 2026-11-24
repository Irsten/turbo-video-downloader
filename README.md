# Turbo Video Downloader (Opera / Chromium)

The extension detects videos on web pages and downloads them **over many connections at once** – into one MP4 file, with subtitles, with resuming (also after a browser restart) and with live stream recording. The version from this repository can also download from YouTube, through yt-dlp.

## Installing in Opera

1. Type `opera://extensions` in the address bar.
2. Turn on **Developer mode** (the switch in the top right corner).
3. Click **Load unpacked** and select the `turbo-video-downloader` folder (the one with `manifest.json`).
4. Pin the extension icon to the toolbar (puzzle icon → pin).
5. **Reload** the tabs that were open before the installation.

After updating to a newer version, click **Reload** on the extension (version 1.2 added permissions for the context menu and notifications, 1.4 – for the YouTube helper program).

It also works in Chrome, Edge, Brave and Vivaldi (same steps, e.g. `chrome://extensions`).

The extension speaks the browser's language: Polish in a Polish browser, English everywhere else.

## How to use

1. Open a page with a video and **start playback** (that's when the player starts fetching the stream and the extension picks it up). The number on the icon shows how many videos were detected.
2. Click the extension icon. Each video shows a thumbnail, its duration and – next to every quality – the estimated size. Choose the quality and, if available, the **audio track** (language) and **subtitles**. You can edit the file name right there. Click **⚡ Download**.
3. The **Download manager** tab opens with a progress bar, speed and time remaining. Progress is also shown on the extension icon and in the tab title; when the manager is in the background, a notification appears when the download finishes (clicking it shows the file in its folder).
4. The finished file lands in the default downloads folder (or the browser asks where to save it, if you enable that in the settings). Subtitles are saved next to it as `.srt` – VLC, MPC-HC and the Windows player load them automatically.

In the manager you can also paste a link to an `.mp4`/`.webm` file, an `.m3u8` playlist or an `.mpd` manifest. A video or a link to a video can also be downloaded with **right click → ⚡ Download … (Turbo)** (for videos played from a stream, the list of detected sources opens).

### File name

The default name comes from the template in the manager settings (**File name**), e.g. `{title} [{quality}]` → "Cat video [720p]". Available variables: `{title}` (page title), `{quality}` (e.g. 720p), `{file}` (name from the address), `{site}` (domain), `{date}`. Empty variables disappear together with the brackets around them. Templates saved with the Polish variable names of older versions (`{tytuł}`, `{jakość}`…) keep working.

### History

Below the list of downloads the manager shows the history of finished downloads (it survives closing the browser): **Show** opens the folder with the file, **Download again** adds the same download once more.

### Pausing and resuming

Downloaded data goes straight to disk (the extension's private folder), not into memory. Thanks to that:

- **Pause** / **Resume** – resuming fetches only the missing bytes,
- after an error (e.g. a dropped connection) **Resume** continues from where it stopped,
- after **closing the manager tab or restarting the browser** downloads resume by themselves when you open the manager again (the popup shows the number of unfinished downloads),
- ✕ removes the job together with the downloaded data.

If the link expires in the meantime, the manager tells you to reload the page with the video.

### Live streams

For an HLS live stream the popup shows **⏺ Record**. Recording goes on until you click **⏹ Stop and save** in the manager (or the stream ends). If the manager is closed during recording, after reopening it you can **save the recorded part** or **keep recording**.

### Pages without reloads

On pages that change the address without reloading (X, Instagram…), the badge on the icon counts the videos of the current sub-page, and those from earlier sub-pages are in the collapsed **Earlier on this tab** section of the popup.

## YouTube (personal build)

The version from this repository can also download from YouTube – **the store package doesn't** (`npm run package` leaves it out). The extension doesn't fetch YouTube's streams itself: [yt-dlp](https://github.com/yt-dlp/yt-dlp), a free program on your computer, does the downloading, and the extension talks to it through a small helper, `native/host.mjs` (Chrome's "native messaging").

Setting it up (once):

1. Install yt-dlp – and, optionally, ffmpeg:
   - Windows: `winget install yt-dlp.yt-dlp Gyan.FFmpeg`
   - macOS: `brew install yt-dlp ffmpeg`
   - Linux: `pipx install yt-dlp` and ffmpeg from your distribution
2. Install [Node.js](https://nodejs.org) 20.16 or newer.
3. Open the download manager: the **YouTube (yt-dlp)** panel shows the command with your extension's ID. Run it in a terminal, in the extension's folder:
   ```bash
   node native/install.mjs <extension-id>
   ```
   It registers the helper with Chrome (also read by Opera and Vivaldi), Edge, Brave and Chromium of the current user, and creates `native/config.json`.
4. Click **Check again** in the panel – it shows the yt-dlp version, whether ffmpeg was found and the folder for the files.

Then open a video on YouTube and click the extension icon: the card shows the qualities from yt-dlp with their sizes, **Audio only (M4A)** and the subtitles. The download appears in the manager like any other – with progress, **Pause** / **Resume** (yt-dlp continues its partial file) and history.

- The files go straight to the folder from `native/config.json` (your downloads folder by default), not through the browser's download list – **Show in folder** opens it. Partial downloads wait in its `.turbo-video-downloader` subfolder.
- **Without ffmpeg** video and audio are merged into one MP4 by the extension's own remuxer, which handles MP4/M4A only – so qualities available only as WebM (usually above 1080p) are off. **With ffmpeg** yt-dlp merges everything, all qualities are available.
- Subtitles are saved next to the video as `.srt`. Live streams aren't supported.
- `native/config.json`: `ytdlp` and `ffmpeg` (paths, if they aren't in `PATH`; `"ffmpeg": "none"` turns ffmpeg off), `outDir`, `extraArgs` – extra yt-dlp arguments, e.g. `["--cookies", "C:/Users/me/cookies.txt"]` when YouTube asks to sign in.
- If something goes wrong, the helper writes `turbo-video-downloader-host.log` in the system temp folder. `node native/install.mjs --uninstall` removes the registration.
- Download only what you're allowed to: YouTube's terms of service forbid downloading without its permission, except where it offers a download option itself.

## Where the speed comes from

| Mechanism | What it gives |
|---|---|
| **Many connections per file** (HTTP Range) | The file is split into chunks downloaded in parallel (6 by default). Servers and CDNs often limit speed *per connection*, so the total is several times faster. |
| **On-the-fly splitting** | When one worker finishes while another still has a lot to download, the slow chunk is split in half and taken over. The end of a download doesn't "hang" on a single slow connection. |
| **Parallel HLS/DASH segments** | 8 segments at once by default (instead of one after another as in a player). |
| **Resuming** | A dropped connection resumes from the last written byte, with retries. |
| **No browser cache** | Data is not written a second time into the HTTP cache. |

Settings (at the top of the manager):

- **Connections per file**: 6 is optimal for most servers. Opera, like every Chromium-based browser, opens at most 6 connections to an HTTP/1.1 server, so more helps only with HTTP/2 and HTTP/3 servers.
- **Segments at once**: 8–16. With a very fast connection you can go higher.
- **Downloads at once**: how many videos at the same time (live recordings don't count towards the limit).
- **Merge into one MP4 file**: video, audio and segments are put together into one `.mp4` (on by default).

## One MP4 file

HLS segments (TS and fMP4), DASH and separate audio tracks are put together into a regular `.mp4` file **without re-encoding** (like `ffmpeg -c copy` – no quality loss, in a few seconds). The extension does it on its own, without external programs.

| Input | Result |
|---|---|
| HLS TS with H.264 + AAC (also separate "packed AAC" audio) | ✅ `.mp4` |
| HLS fMP4 / CMAF, DASH (fMP4) – any codec | ✅ `.mp4` |
| TS with H.265, AC-3, MP3; DASH in WebM | ⚠️ saved without merging (`.ts` / separate files) + a ready ffmpeg command |

When merging isn't possible, the manager saves the files as they are and shows a command to merge them by hand ([ffmpeg](https://ffmpeg.org/download.html)), e.g.:

```bash
ffmpeg -i "video.ts" -c copy "video.mp4"
```

## Supported formats

| Format | Status |
|---|---|
| MP4, WebM, MOV, MKV, M4V… (direct file) | ✅ multi-connection |
| HLS `.m3u8` (TS and fMP4, choice of quality and audio track, BYTERANGE) | ✅ parallel segments → one `.mp4` |
| HLS live | ✅ recording until stopped |
| DASH `.mpd` (SegmentTemplate, SegmentTimeline, SegmentList, SegmentBase) | ✅ choice of quality and audio → one `.mp4` |
| DASH live, DASH with several periods | ❌ no live; of several periods only the first one is downloaded |
| WebVTT subtitles (HLS, DASH, `<track>` on the page) | ✅ saved as `.srt` next to the video |
| DRM-protected / encrypted content (Netflix, Disney+, paid VOD…) | ❌ deliberately not supported |
| YouTube | ✅ personal build only, through yt-dlp – see [YouTube (personal build)](#youtube-personal-build); ❌ not in the store package |

## Limitations

- Downloaded data takes space on the system disk (in the browser profile) until the finished file is saved; then it is removed.
- If a page requires cookies and a `Referer` header, the extension sends them just like the page does. Links with an expiring token have to be downloaded right after they are detected – after a browser restart, resuming may require reloading the page.

## Development

Requirements: Node 20.16+ and – for the browser tests – Chrome 126+. Install the dev tools once with `npm install` (only ESLint; the extension itself has no dependencies).

```bash
npm run lint         # ESLint
npm test             # engine, HLS/DASH/subtitle parsers, merging into MP4, translations, YouTube helper – a dozen or so seconds
npm run test:remux   # merging into MP4 checked with the Chrome player
npm run test:e2e     # the whole extension in a background Chrome (English and Polish UI), on a temporary profile
npm run package      # dist/turbo-video-downloader-<version>.zip for Opera Add-ons / Chrome Web Store (without YouTube)
```

A local test server simulates expired links, 403/404 errors, dropped connections, a slow connection, servers without Range, a live stream, HLS and DASH. The Chrome tests find the browser on their own (point to another one with the `CHROME` variable). `HEADFUL=1` shows the window, and `KEEP=1` keeps the profile and the downloaded files for inspection. To test the store package itself, unpack the zip and run `EXT_ROOT=<folder> npm run test:e2e`.

The YouTube helper is tested with a fake yt-dlp (`tests/fake-ytdlp.mjs`: the info JSON from `tests/fixtures/ytdlp-info.json`, downloads of the test recordings with progress, resuming and merging). The browser test registers a test copy of the helper as `com.turbovd.ytdlp.test` in the current user's registry (Windows only) and removes it at the end; the store package is checked to have no YouTube at all.

The test recordings in `tests/fixtures/` (H.264/AAC from WebCodecs, MP4 from MediaRecorder) were generated by Chrome; `npm run fixtures` creates them again.

`npm run package` puts only the runtime files into the zip (no tests, configs or `node_modules`) and leaves the personal build out: `lib/external.js` is replaced with the stub from `scripts/store/`, the manifest loses the `nativeMessaging` permission and the translations their `yt*` messages. First it checks that everything the manifest, the pages and the imports refer to is inside, that all translations have the same keys and that nothing of the personal build is left.

### Translations

All texts shown to the user are in `_locales/<language>/messages.json` (English is the default, `en`; Polish is `pl`). In code they come from `tr('key', …values)` in `lib/i18n.js`, and in HTML from `data-i18n` / `data-i18n-title` / `data-i18n-placeholder` attributes. `$1`…`$9` in a message are replaced with the values. To add a language, copy `_locales/en` to `_locales/<code>` and translate the messages – `npm test` checks that no key or substitution is missing.

## Structure

```
manifest.json        – configuration (Manifest V3)
background.js        – detecting videos in network traffic
content.js           – detecting <video>, <track> and links on the page
popup.html/js        – list of detected videos, choice of quality / audio / subtitles
manager.html/js      – download manager (progress, resuming, merging, saving)
lib/engine.js        – engine: multi-connection Range, HLS/DASH segments, live recording
lib/store.js         – working files on disk (OPFS) + store-worker.js
lib/remux.js         – merging into one MP4 (ts.js – TS demuxer, mp4.js – MP4 reading/writing)
lib/hls.js           – .m3u8 parser
lib/dash.js          – .mpd parser (xml.js – minimal XML parser)
lib/subs.js          – WebVTT subtitles → SRT
lib/net.js           – Referer/Origin headers (declarativeNetRequest)
lib/media.js         – format detection, file names
lib/jobs.js          – queue and settings
lib/i18n.js          – translations (chrome.i18n)
lib/external.js      – YouTube through the helper program (personal build; scripts/store/external.js in the store package)
native/              – the helper program: host.mjs (native messaging + yt-dlp), install.mjs (registration), config.mjs
_locales/            – texts in English (default) and Polish
tests/               – tests (Node and Chrome), test recordings and a fake yt-dlp
scripts/package.mjs  – building the store zip
package.json         – dev scripts (the extension does not use Node)
eslint.config.js     – ESLint configuration
```
