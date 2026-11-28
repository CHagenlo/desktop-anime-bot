# Desktop Anime AI Companion

A Windows desktop companion prototype with a movable 3D character, configurable AI connections, and explicit controls for desktop access. The character can react to the cursor, perch on an approved selected window, chat through your chosen AI service, and perform a small set of window actions that you request.

**Naming is still open.** “Sillie” for the app and `sillie-desktop` for a repository are suggested working names awaiting your choice. The current source directory and package use `desktop-anime-bot`; the Electron application identifier is `DesktopAnimeBot`.

## Try it on Windows

Version **0.2.0** adds microphone transcription, encrypted conversation memory, and visible local-model loading stages to the Windows x64 installer and portable builds. **[Download the verified 0.2.0 Windows test build](https://github.com/CHagenlo/desktop-anime-bot/releases/tag/v0.2.0-test.5.1).** Its [Windows build](https://github.com/CHagenlo/desktop-anime-bot/actions/runs/46135949197) passed all 153 automated tests, package checks, and unpacked/portable startup and feature checks. See [verification status](docs/verification.md) for the test scope and remaining hands-on checks. Future downloads appear in [GitHub Releases](https://github.com/CHagenlo/desktop-anime-bot/releases) after the required build gates succeed.

### Install the app

1. Open [Releases](https://github.com/CHagenlo/desktop-anime-bot/releases) and choose the newest successful Windows test build.
2. Under **Assets**, download **`Desktop-Anime-Bot-Setup-0.2.0-x64.exe`**. The **Source code** ZIP is for developers.
3. Open the downloaded installer. It installs for your Windows account and creates Start menu and desktop shortcuts.
4. Open **Desktop Anime Bot**. Review the settings, add an AI connection, and select **Resume companion** when ready.

To update an existing copy, choose **Quit** in the app or its tray menu before opening the new installer or portable executable. Closing Settings only hides it. The new version uses the same saved connections, keys, and character settings in `%APPDATA%\DesktopAnimeBot`. Conversation persistence applies to chats saved by 0.2.0; it cannot recover conversations from earlier sessions that were never written to disk.

The download includes Electron, the original test character, and a compiled Windows window helper. **You do not need Node.js, npm, or PowerShell setup to use an installed build.** Conversation still requires your own AI API key or a separately configured local model server.

These are **unsigned test builds**. Windows may show an unknown publisher or a reputation warning. If Windows or your organization's policy blocks the executable, leave those protections enabled; report the block with the release version. Code signing and automatic updates are not included yet.

### Run without installing

Download **`Desktop-Anime-Bot-Portable-0.2.0-x64.exe`** from the same release and open it. It launches without an installation wizard or shortcuts. Although the executable extracts its runtime files temporarily, your settings, encrypted keys, saved conversations, and imported avatar are saved in **`%APPDATA%\DesktopAnimeBot`**, just as with the installed version. The portable version shares that profile on the same Windows account; it does not keep your profile beside the executable.

### Windows requirements

- **Windows 10 22H2 or Windows 11, x64**. These builds target Intel/AMD 64-bit Windows; Windows on ARM has not been verified.
- **.NET Framework 4.8 or later** for the included window helper. Windows 10 22H2 and Windows 11 include a compatible version. See [Microsoft's Framework installation information](https://learn.microsoft.com/en-us/dotnet/framework/install/on-windows-10).
- Network access to the chosen hosted AI provider, or a separately installed Ollama/LM Studio server and model for local AI. The companion does not download AI models.

The settings window and character open together. **Every launch starts paused**, even if the previous session was running. Closing the settings window hides it; use the tray menu or **Quit** to exit the application completely. Uninstalling the installed app preserves the profile in `%APPDATA%\DesktopAnimeBot`.

## What is included

- An Electron settings window with **Chat**, **AI connections**, **Voice & memory**, **Desktop privacy**, and **Character** tabs.
- A transparent character overlay with an original procedural 3D test avatar, cursor look, blinking, head pats, dragging, and a simple sitting pose.
- Import of a self-contained `.vrm` avatar, with a maximum size of 50 MiB.
- Saved AI profiles, password-style key entry, model discovery, and manual model IDs.
- A model activity bar with checking, loading, and generating stages for supported local runtimes.
- Optional microphone recording that becomes an editable text draft before you send it.
- Encrypted text-chat persistence for each AI profile, with a memory switch and clear controls.
- Three independent desktop capability switches, protected per-app rules, Work/Play presets, and pause/resume controls.
- Selected-window descriptions on explicit request, plus direct move, resize, minimize, restore, and single-action undo controls.
- Optional spoken replies through an installed **local system voice**.

This is a development test release. The avatar animation and mouth movement are basic. There is no always-listening microphone, token-by-token response streaming, autonomous tool loop, or continuous screen-watching mode. A successful automated build does not establish live AI compatibility or reliable interaction with every Windows application. See [verification status](docs/verification.md) for the checks performed and the remaining Windows testing.

## First conversation

1. Open **AI connections** and add a profile.
2. Choose a provider, give the profile a name, and review its endpoint. Enter your own API key if the endpoint requires one.
3. Select **Save & use profile**. A model ID may be left blank at this stage.
4. Select **Discover models**, or enter an exact model ID manually. Choose a model and save again.
5. Resume the companion, open **Chat**, and send a message. Enter sends; Shift+Enter inserts a line break.

A saved profile is selected, not automatically connection-tested. A successful model list establishes that discovery worked; it does not prove that a particular model can chat or accept images. Replies currently appear once the provider returns the complete answer.

Profiles are available for OpenAI, Anthropic/Claude, Google/Gemini, xAI/Grok, DeepSeek, Mistral, Ollama, LM Studio, and custom OpenAI-compatible endpoints. Compatibility depends on the actual endpoint and model. Models are not hard-coded, and a failed request never switches to a different provider automatically.

Each saved connection has its own bounded conversation. **Remember conversations** is enabled by default, so completed text chats can return after restart using protected storage on this PC. Switching profiles does not send one profile's history to another. **Clear chat** clears the active profile's current and saved conversation. Replacing a profile's provider, model, endpoint, workspace, or key clears its earlier authentication/model context. See [Conversation memory](#conversation-memory) for retention limits and deletion controls.

### Use local AI

In **AI connections**, enable **Keep AI on this computer**, then select an **Ollama · local** or **LM Studio · local** profile. The preset endpoints are:

| Runtime | Preset endpoint |
|---|---|
| Ollama | `http://localhost:11434` |
| LM Studio | `http://localhost:1234/v1` |

Start the local server and make a model available in that runtime before discovering models. An optional key can be supplied if the local server requires authentication. LM Studio discovery uses its native `/api/v1/models` API; inference uses its compatible chat endpoint.

On a request to a verified local model, the companion checks whether the selected model is already loaded. A cold Ollama or LM Studio model is explicitly loaded before the chat request proceeds. The activity card shows **Checking model**, **Loading model** when needed, and **Generating a reply**, with an animated bar and elapsed time. These loading endpoints do not report a completion fraction, so the bar is indeterminate and does not invent a percentage. A warm model skips the loading stage.

The loading step allows up to five minutes. If it times out, try loading the model in your local AI application, then retry. **Stop** cancels the companion's request and discards late results; the model server may finish loading the model after the client cancels. This does not download a missing model. The preparation follows [Ollama's preload interface](https://docs.ollama.com/faq#how-can-i-preload-a-model-into-ollama-to-get-faster-response-times) and [LM Studio's model-load interface](https://lmstudio.ai/docs/developer/rest/load).

Local-only mode accepts these two runtime presets on loopback addresses and checks model metadata before sending prompts. Cloud-marked or unverified local models are rejected. The generic compatible preset is not accepted in this mode, even when its address is loopback. Hosted profiles can remain saved, but requests to them are blocked until local-only mode is turned off.

**Local-only is an endpoint and model validation policy, not a firewall.** It cannot stop Ollama, LM Studio, or another program from making its own network requests, and it relies on the local runtime's metadata. Consult [Ollama's local FAQ](https://docs.ollama.com/faq) and [LM Studio's API documentation](https://lmstudio.ai/docs/developer/rest) for those runtimes' own settings.

## Microphone input

Microphone input starts **off**. Set it up in **Voice & memory**, separately from the connection used for chat. The saved audio destination is displayed before recording.

| Transcription choice | Settings and prerequisites |
|---|---|
| **Whisper.cpp · local** | Run a separately installed **whisper.cpp v1.9.1 or later** server with a speech model loaded. The default endpoint is `http://127.0.0.1:8080`; the companion sends WAV audio to `/inference`. Leave the model field blank because the server chooses its loaded model. |
| **OpenAI transcription** | The preset endpoint is `https://api.openai.com/v1` and its default model is `gpt-transcribe`. Supply your own transcription API key and a model available to that account. This sends the recorded audio to the configured hosted service. |
| **Custom · OpenAI-compatible transcription** | Enter an endpoint implementing `/audio/transcriptions`, its model ID, and an optional key if required. Compatibility depends on that service's audio API. |

For the local option, follow the [official whisper.cpp server instructions](https://github.com/ggml-org/whisper.cpp/blob/v1.9.1/examples/server/README.md), load a speech model in that server, and keep it running on `127.0.0.1:8080` or another loopback port you configure. The companion does not install, start, or download the speech server/model. Ollama and LM Studio chat profiles do not automatically provide this transcription service.

Choose a transcription provider, review its endpoint, enter the model/key when needed, enable microphone input, and select **Save voice settings**. Language can be left blank for detection or set to a two-letter code such as `en`. The transcription key is stored as a separate protected credential; your chat key is not automatically reused.

### Record, review, then send

1. Resume the companion and open **Chat**.
2. Select **Record message**. Only this explicit action opens the microphone.
3. Select **Stop & transcribe** when finished. A recording also stops and proceeds to transcription at the **60-second** limit.
4. Review the recognized text in the chat draft and edit it as needed.
5. Select **Send** to send that text to the selected chat AI.

**Discard** stops a recording without transcription. During transcription, **Cancel** discards a late result. Canceling cannot recall audio already sent to the selected speech service. Transcription never automatically sends a chat message, and the draft is not saved as conversation memory until you send it and a text reply completes.

The companion keeps raw audio transiently for the recording/transcription request and does not write audio recordings to its files or conversation memory. The selected speech server's own handling of received audio still applies. With **Keep AI on this computer** enabled, microphone input accepts only the whisper.cpp preset on a loopback address; hosted and custom transcription endpoints are blocked. The local-only setting does not control another program's network access.

If the microphone is denied or unavailable, check Windows microphone access for desktop apps and the default input device. Typed chat remains available. Spoken replies are configured separately under **Character → Read replies aloud**.

## Conversation memory

In **Voice & memory**, **Remember conversations** controls persistence of completed text chats. It is enabled by default. Saved transcripts are encrypted using Windows protection in `conversations.enc.json` inside the normal app profile, separately from API keys. They are restored only to the same AI profile and destination/model/key context.

| Limit | Behavior |
|---|---|
| Saved text per profile | Up to **200 messages** in complete user/assistant turns, within **524,288 characters**. Older turns outside this window are removed. |
| Saved text across profiles | Up to **2,097,152 characters** across at most 40 profiles. The least recently saved profiles are removed first when the total limit is reached. |
| Context sent on a new text request | Up to the **20 most recent prior messages** that fit with your current prompt inside **32,768 characters**. Character/system instructions are additional. A larger saved transcript is not sent in full on every request. |

This is bounded transcript memory. It does not summarize every conversation into permanent facts or search an unlimited archive. Your prior messages are sent to the same selected AI profile when they fit the context window.

- **Clear chat** removes the selected profile's current and saved conversation.
- **Clear all conversations** in Voice & memory removes current and saved chats for every AI profile. It does not remove AI connections, keys, the imported avatar, or other settings.
- Turning **Remember conversations off** clears current and saved chats. New chats then remain in the current session only.
- Turning it **on again** starts fresh and clears current session chats; it never backfills messages sent while saving was off.
- Removing a profile or changing its provider, model, endpoint, workspace, or key clears its earlier conversation context.

Screen captures, screenshot-description questions and answers, and raw audio are excluded from this memory. A microphone transcript becomes ordinary text chat only after you review and send it.

If Windows protection is unavailable, a saved file is damaged, or a write fails, chat continues in the current session and the memory status explains the problem. There is no plaintext fallback. An unreadable saved file is preserved until explicitly cleared; **Clear all conversations** can reset it without decrypting it. A deletion failure is reported instead of being treated as a successful clear.

## Desktop access: three separate choices

Open **Desktop privacy**. Each capability requires its global switch **and** the corresponding permission for the selected app. A protected app overrides all grants.

| Global capability | Per-app column | What it permits in this prototype |
|---|---|---|
| React to window layout | Layout | Perch on the selected window and follow its position. It does not read its contents. |
| See window contents | Contents | Capture and describe the selected window when you press **Describe selected window**. |
| Manage windows | Actions | Apply your direct move, resize, minimize, restore, or undo request to the selected window. |

### Set up an app rule

1. Select **Refresh windows**, choose a window, and press **Select**.
2. Select **Add selected app**. Its permissions start off.
3. Enable only the columns you want, or mark the app **Protected**.
4. Enable the corresponding global capability when you want to use it.

Rules match the application's executable path. They are not individual browser-tab or website rules. If a browser or other app mixes sensitive work with personal content, protect that executable or leave its Contents permission off. A target's title is checked, but a title check cannot classify the content of a page.

Refreshing windows lists titles and executable paths locally so you can choose targets and configure rules. This does not capture images or send those titles to an AI provider. Protected apps may still appear in that local list; their three capabilities remain denied.

### Work, Play, and pause

- **Work** switches all three desktop capabilities off and uses calm animation. It does not automatically change your AI endpoint, local-only setting, or speech preference.
- **Play** restores your saved capability choices and uses playful animation. Protected app rules still apply.
- Changing an individual capability creates a **Custom** mode and updates the choices Play will restore.
- **Pause everything** stops active requests and desktop activity. Resume restores access according to the current switches and app rules. Pause cannot recall data already transmitted to a provider or reverse an action that already finished.

Dragging the character detaches her from the selected window. To reattach, select another permitted target, or switch layout reactions off and on for the current target. Edge placement and sitting animation are basic and still need Windows display-scaling testing.

### Describe a selected window

Choose an AI profile whose selected model accepts images and enable **This model accepts images**. Permit Contents for the selected app and enable the global contents switch. The description card displays the **profile, model, and endpoint** that will receive the image. Enter a question and press **Describe selected window**.

The helper attempts isolated capture of that window using Windows `PrintWindow`; it never substitutes a whole-desktop screenshot. The target must be restored and must support usable capture. Identity changes, unsupported rendering, blank output, oversized input, or a capture failure produce an error. Some applications and games will not work with this capture method. [Microsoft documents that the target application supplies the rendered image for `PrintWindow`.](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-printwindow)

The screenshot and its answer are not appended to later text-chat history or written to screenshot files by this application. The selected AI service still receives the requested image, so its handling of that request applies.

### Manage a selected window

Use the **Arrange this window** buttons for movement, size, minimize, restore, and undo. Restore a minimized target before moving, resizing, or capturing it. Undo remembers only the most recent eligible action; changing targets or rules can clear it.

The chat handler also recognizes these exact, user-written commands:

```text
/window left
/window right
/window up
/window down
/window minimize
/window restore
/window undo
```

These commands use the same selected target and permissions. The current chat UI requires a selected model before sending; the dedicated desktop buttons work independently of an AI connection. AI-generated replies are never interpreted as commands. The prototype cannot close windows, type into other apps, delete files, or execute a command suggested by a model.

## Character and voice

In **Character**, set the name, personality, and playfulness, then save. Personality affects conversation; playfulness changes animation intensity without granting access to apps.

**Import a VRM avatar** opens a local file picker. The file must be a valid self-contained binary VRM with embedded resources. External asset references are rejected. Imported model quality, rigging, and available expressions affect the result. Unsupported models leave the stand-in available. The rendering path uses [Three.js and the official three-vrm integration](https://github.com/pixiv/three-vrm).

On the desktop, drag the character to move, click her head to pat, or right-click to open settings. The overlay controls provide settings, pause/resume, hide, and quit. Mouth movement is an approximation, not phoneme-accurate lip synchronization.

**Read replies aloud** uses only an installed voice identified by the system as local. If one is unavailable, the app shows captions and reports that limitation. It does not provide a custom anime voice or cloud speech output. Configure optional microphone transcription separately in **Voice & memory**; replies still begin only after you send the reviewed draft.

| Shortcut | Action |
|---|---|
| Ctrl+Shift+Space | Open settings |
| Ctrl+Shift+H | Show or hide the character |
| Ctrl+Shift+P | Toggle pause/resume |

If another application already owns a shortcut, use the tray menu. Hiding the character is separate from pausing activity.

## Data and credentials

The application explicitly stores its normal Windows profile in **`%APPDATA%\DesktopAnimeBot`**. Installed and portable builds use the same location, and the installer preserves it during uninstall:

| File/data | Contents |
|---|---|
| `settings.json` | Plain JSON preferences, chat and transcription endpoints/model IDs, memory choice, character settings, and executable access rules. No API keys or chat text. |
| `credentials.enc.json` | Separate chat and transcription credentials protected using Electron `safeStorage` on Windows. |
| `conversations.enc.json` | Protected text transcripts for each AI profile when memory is enabled and available. |
| `avatar.vrm` | A local copy of the imported avatar. |
| Raw audio, screen images, and screenshot descriptions | Transient request data; excluded from conversation storage. The selected service receives the data explicitly sent to it. |

The renderer receives only a `hasKey` flag. Keys are bound to the provider, normalized endpoint, and workspace; changing that binding requires a replacement key or removal of the previous key. The prototype refuses key storage if supported Windows protection is unavailable. Electron's [safeStorage documentation](https://www.electronjs.org/docs/latest/api/safe-storage) explains its Windows protection and its limits, including access by other applications running as the same user.

## Troubleshooting

| Situation | What to check |
|---|---|
| Chat is disabled | Resume the companion, select a profile, choose a model, and check local-only mode. |
| Discovery fails | Save endpoint/key changes first, confirm server availability and credentials, or enter a supported model ID manually. |
| A local model stays on Loading | Check the model server, available memory, and selected model. The load step times out after five minutes; loading it directly in Ollama/LM Studio may help diagnose the cause. The bar does not estimate a completion percentage. |
| Record message is unavailable | Resume, enable microphone input in Voice & memory, save the speech endpoint/model/key, and check local-only mode. Finish or cancel the current AI request first. |
| The microphone is denied or missing | Check Windows microphone access for desktop apps and the default recording device. |
| Transcription cannot connect | Start the separately installed whisper.cpp server with a model loaded, or check the hosted/custom speech endpoint, model, and separate API key. |
| A conversation is missing after restart | Check Remember conversations and its status. Changed profile/model/key bindings, the retention limits, or a reported storage failure can prevent restoration. |
| Saved memory cannot be read or cleared | Review the memory status and access to the app data folder. Clear all conversations can remove an unreadable encrypted file; a failed deletion is reported. |
| No installer is listed | Check the Windows workflow for the desired version. Downloads are published only after all release gates pass. |
| Windows reports an unknown publisher | This test release is unsigned. Keep Windows and organization protections enabled, and include the exact release version when reporting a block. |
| Native windows are unavailable in an installed build | Check the error message, the Windows/.NET Framework requirements, and whether security software blocked the included helper. A distributed build uses its compiled helper and does not fall back to a PowerShell script. |
| Target changed or closed | Refresh and select the window again. The exact title, PID, executable, and handle are checked. |
| Window capture fails | Restore the window and use a non-sensitive test window that supports capture. The app intentionally has no whole-desktop fallback. |
| Window controls stay disabled | Check pause state, the global switch, the app's permission column, and its Protected flag. |
| The avatar does not load | Check the VRM format, embedded resources, and 50 MiB limit. Open settings to import another model. |
| No spoken reply | Enable the speech setting and make an installed local system voice available. Captions remain usable. |

## Develop and build from source

These commands are for developers. Installed and portable users can use the download instructions above.

For a Windows build, use Windows x64 with **Node.js 22.12.0 or later**, npm, and .NET Framework 4.8 or later. The native build script uses the .NET Framework C# compiler already present in a suitable Windows installation. The initial dependency and packaging-tool downloads require network access.

Clone or extract this repository, open a terminal inside `desktop-anime-bot`, and run:

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd test
npm.cmd run package:win
npm.cmd run smoke:windows
node scripts/smoke-windows.cjs "dist/Desktop-Anime-Bot-Portable-0.2.0-x64.exe" portable
```

`package:win` compiles the native helper, builds both executables, checks the packaged renderer dependency graph and helper, and writes checksums. The resulting downloads are in `dist/`:

- `Desktop-Anime-Bot-Setup-0.2.0-x64.exe`
- `Desktop-Anime-Bot-Portable-0.2.0-x64.exe`
- `SHA256SUMS.txt`
- `package-verification.json`

For an unpacked application directory, use `npm.cmd run package:win:dir`. To run the source during development, use `npm.cmd start`. `npm.cmd run build:native` builds only the Windows helper. If the development executable has not been compiled, source mode may use its bundled PowerShell loader under the machine's normal script policy; it does not change or bypass that policy. Distributed apps require the compiled helper at `resources/native/desktop-window-helper.exe` and do not ship the PowerShell loader.

### GitHub builds and test releases

[`.github/workflows/windows-build.yml`](.github/workflows/windows-build.yml) runs on pushes to `main` and supports a manual **Run workflow**. Its Windows job installs the locked dependencies, runs source checks/tests, then builds and verifies the unpacked app. After that app passes startup and feature smoke checks, the workflow creates the installer and portable executable from the same directory, verifies the downloads, and smoke-tests the portable executable. These checks must pass before the downloads are uploaded. Smoke reports and window images are available as workflow artifacts when produced.

The feature smoke checks use disposable profiles, synthetic Chromium audio, and local HTTP fixtures for speech and model responses. They exercise the packaged microphone-to-draft flow, visible loading state, and Windows-protected conversation restore/clear. They do not establish physical microphone quality, live transcription accuracy, or real model-loading performance. Normal app launches use your chosen microphone only after you start recording.

A separate publish job creates a **prerelease** for a successful build of `main`, using a unique tag such as `v0.2.0-test.RUN.ATTEMPT`. Releases include both executables, their SHA-256 checksums, package verification details, and the source commit link. A failed build does not publish a new download. The app does not update itself automatically; install or open a newer test build explicitly.

## How it is put together

| Area | Responsibility |
|---|---|
| `renderer/` | Local settings UI, microphone recording/draft insertion, text-only response display, and Three.js/VRM overlay. |
| `src/preload.cjs` | Narrow `window.companion` bridge. |
| `src/main.cjs` | Electron windows, IPC sender validation, tray, shortcuts, avatar import, cursor/perch placement. |
| `src/core/` | Configuration, operation cancellation, permissions, credentials, encrypted text memory, and target checks. |
| `src/providers/` | Chat provider discovery, local-model loading, and generation protocols. |
| `src/audio/` | Microphone grants, bounded WAV validation, separate transcription credentials, and speech-service requests. |
| `src/native/` | Compiled Windows helper source, fixed protocol, window operations, and isolated capture; PowerShell loader for source development only. |
| `tests/` | Offline tests with mocked provider and native transports. |
| `scripts/` | Native compilation, package verification, source checks, and Windows startup smoke checks. |
| `electron-builder.config.cjs` | Windows x64 installer/portable packaging and resource inclusion. |

Renderers use context isolation, sandboxing, restrictive CSPs, and no direct outbound network access. Model and window text is inserted with `textContent`. Privileged operations are validated in the main/core process rather than left to a model instruction. The security approach follows the relevant principles in [Electron's security guide](https://www.electronjs.org/docs/latest/tutorial/security); it has not received an independent security audit.

Run `npm.cmd run check` and `npm.cmd test` after changes. Read [verification status and remaining platform checks](docs/verification.md) before treating this prototype as ready for sensitive daily use.
