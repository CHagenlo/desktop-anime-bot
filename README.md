# Desktop Anime AI Companion

A Windows desktop companion **source prototype** with a movable 3D character, configurable AI connections, and explicit controls for desktop access. The character can react to the cursor, perch on an approved selected window, chat through your chosen AI service, and perform a small set of window actions that you request.

**Naming is still open.** “Sillie” for the app and `sillie-desktop` for a repository are suggested working names awaiting your choice. The current source directory and package use `desktop-anime-bot`; the Electron application identifier is `DesktopAnimeBot`.

## What is included

- An Electron settings window with **Chat**, **AI connections**, **Desktop privacy**, and **Character** tabs.
- A transparent character overlay with an original procedural 3D stand-in, cursor look, blinking, head pats, dragging, and a simple sitting pose.
- Import of a self-contained `.vrm` avatar, with a maximum size of 50 MiB.
- Saved AI profiles, password-style key entry, model discovery, and manual model IDs.
- Three independent desktop capability switches, protected per-app rules, Work/Play presets, and pause/resume controls.
- Selected-window descriptions on explicit request, plus direct move, resize, minimize, restore, and single-action undo controls.
- Optional spoken replies through an installed **local system voice**.

This is version 0.1.0 source, not an installer or a finished commercial character. There is no microphone input, token-by-token response streaming, persistent conversational memory, autonomous tool loop, or continuous screen-watching mode. Windows runtime behavior, real API keys, live provider calls, and visual rendering have not yet been verified. See [verification status](docs/verification.md).

## Run on Windows

### Requirements

- A Windows desktop with **Node.js 22 or later** and npm.
- Network access for the initial dependency/Electron download. Hosted AI use also requires access to the selected provider.
- For local AI, a separately installed and running Ollama or LM Studio server with a suitable model. This project does not install or download AI models.
- The bundled Windows PowerShell helper must be permitted by your machine's normal policy for native window features. The application does not alter or bypass PowerShell policy.

Extract the project and open a terminal **inside the `desktop-anime-bot` folder**, then run:

```powershell
node --version
npm.cmd ci
npm.cmd run check
npm.cmd test
npm.cmd start
```

`npm.cmd ci` installs the exact dependencies in `package-lock.json`, including Electron's setup step. The `npm.cmd` form is usable from either Command Prompt or PowerShell on Windows. Keep the source folder and its installed `node_modules` together when starting the app.

The settings window and character open together. **Every launch starts paused**, even if the previous session was running. Configure your choices, then select **Resume companion**. Closing the settings window hides it; use the tray menu or **Quit** to exit the application completely.

## First conversation

1. Open **AI connections** and add a profile.
2. Choose a provider, give the profile a name, and review its endpoint. Enter your own API key if the endpoint requires one.
3. Select **Save & use profile**. A model ID may be left blank at this stage.
4. Select **Discover models**, or enter an exact model ID manually. Choose a model and save again.
5. Resume the companion, open **Chat**, and send a message. Enter sends; Shift+Enter inserts a line break.

A saved profile is selected, not automatically connection-tested. A successful model list establishes that discovery worked; it does not prove that a particular model can chat or accept images. Replies currently appear once the provider returns the complete answer.

Profiles are available for OpenAI, Anthropic/Claude, Google/Gemini, xAI/Grok, DeepSeek, Mistral, Ollama, LM Studio, and custom OpenAI-compatible endpoints. Compatibility depends on the actual endpoint and model. Models are not hard-coded, and a failed request never switches to a different provider automatically.

Each saved connection has its own bounded conversation in memory. Switching profiles does not send one profile's history to another. **Clear chat** clears the active profile's conversation; exiting the app clears all conversational histories. Replacing a profile's model, endpoint, workspace, or key also clears its earlier authentication/model context where applicable.

### Use local AI

In **AI connections**, enable **Keep AI on this computer**, then select an **Ollama · local** or **LM Studio · local** profile. The preset endpoints are:

| Runtime | Preset endpoint |
|---|---|
| Ollama | `http://localhost:11434` |
| LM Studio | `http://localhost:1234/v1` |

Start the local server and make a model available in that runtime before discovering models. An optional key can be supplied if the local server requires authentication. LM Studio discovery uses its native `/api/v1/models` API; inference uses its compatible chat endpoint.

Local-only mode accepts these two runtime presets on loopback addresses and checks model metadata before sending prompts. Cloud-marked or unverified local models are rejected. The generic compatible preset is not accepted in this mode, even when its address is loopback. Hosted profiles can remain saved, but requests to them are blocked until local-only mode is turned off.

**Local-only is an endpoint and model validation policy, not a firewall.** It cannot stop Ollama, LM Studio, or another program from making its own network requests, and it relies on the local runtime's metadata. Consult [Ollama's local FAQ](https://docs.ollama.com/faq) and [LM Studio's API documentation](https://lmstudio.ai/docs/developer/rest) for those runtimes' own settings.

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

**Read replies aloud** uses only an installed voice identified by the system as local. If one is unavailable, the app shows captions and reports that limitation. It does not provide a custom anime voice, cloud speech service, or microphone conversation.

| Shortcut | Action |
|---|---|
| Ctrl+Shift+Space | Open settings |
| Ctrl+Shift+H | Show or hide the character |
| Ctrl+Shift+P | Toggle pause/resume |

If another application already owns a shortcut, use the tray menu. Hiding the character is separate from pausing activity.

## Data and credentials

Application data is stored in Electron's user-data directory, normally `%APPDATA%\DesktopAnimeBot` on Windows:

| File/data | Contents |
|---|---|
| `settings.json` | Plain JSON preferences, provider endpoints/model IDs, character settings, and executable access rules. No API keys. |
| `credentials.enc.json` | API keys protected using Electron `safeStorage` on Windows. |
| `avatar.vrm` | A local copy of the imported avatar. |
| Conversation histories | Memory only; separate per profile and lost on app exit. |

The renderer receives only a `hasKey` flag. Keys are bound to the provider, normalized endpoint, and workspace; changing that binding requires a replacement key or removal of the previous key. The prototype refuses key storage if supported Windows protection is unavailable. Electron's [safeStorage documentation](https://www.electronjs.org/docs/latest/api/safe-storage) explains its Windows protection and its limits, including access by other applications running as the same user.

## Troubleshooting

| Situation | What to check |
|---|---|
| Chat is disabled | Resume the companion, select a profile, choose a model, and check local-only mode. |
| Discovery fails | Save endpoint/key changes first, confirm server availability and credentials, or enter a supported model ID manually. |
| Native windows are unavailable | Confirm Windows PowerShell and the bundled helper are permitted in the environment. Machine policy may block execution. Do not change or bypass policy as a workaround; native features can remain unavailable while you use chat and the avatar. |
| Target changed or closed | Refresh and select the window again. The exact title, PID, executable, and handle are checked. |
| Window capture fails | Restore the window and use a non-sensitive test window that supports capture. The app intentionally has no whole-desktop fallback. |
| Window controls stay disabled | Check pause state, the global switch, the app's permission column, and its Protected flag. |
| The avatar does not load | Check the VRM format, embedded resources, and 50 MiB limit. Open settings to import another model. |
| No spoken reply | Enable the speech setting and make an installed local system voice available. Captions remain usable. |

## How it is put together

| Area | Responsibility |
|---|---|
| `renderer/` | Local settings UI, text-only response display, and Three.js/VRM overlay. |
| `src/preload.cjs` | Narrow `window.companion` bridge. |
| `src/main.cjs` | Electron windows, IPC sender validation, tray, shortcuts, avatar import, cursor/perch placement. |
| `src/core/` | Configuration, operation cancellation, permissions, credentials, conversations, and target checks. |
| `src/providers/` | Provider-specific discovery and generation protocols; all AI network calls. |
| `src/native/` | Windows-only helper protocol, Win32 window operations, and isolated capture. |
| `tests/` | Offline tests with mocked provider and native transports. |

Renderers use context isolation, sandboxing, restrictive CSPs, and no direct outbound network access. Model and window text is inserted with `textContent`. Privileged operations are validated in the main/core process rather than left to a model instruction. The security approach follows the relevant principles in [Electron's security guide](https://www.electronjs.org/docs/latest/tutorial/security); it has not received an independent security audit.

Run `npm.cmd run check` and `npm.cmd test` after changes. Read [verification status and remaining platform checks](docs/verification.md) before treating this prototype as ready for sensitive daily use.
