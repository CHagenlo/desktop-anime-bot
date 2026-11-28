# Verification status

This record applies to the **Desktop Anime AI Companion 0.2.0** changes: microphone transcription, encrypted conversation persistence, and explicit local-model loading progress. It preserves the earlier 0.1.1 Windows evidence separately from checks for this revision.

## Version 0.2.0: verified Windows build

| Area | Recorded result |
|---|---|
| Core and conversation-memory tests | **52 of 52 targeted tests pass** in `tests/core.test.mjs` and `tests/memory.test.mjs`. These include encrypted restart restoration, profile and key separation, clear/disable races during encryption, cancellation, damaged storage, unavailable protection, limits, and active-request progress forwarding/reset. |
| Full revision validation | **153 of 153 tests pass** in the integrated development workspace and Windows CI. The source check also passes, including syntax checks for **29 JavaScript files**. |
| Windows build and packaged startup | **Passed in [Windows build 5](https://github.com/CHagenlo/desktop-anime-bot/actions/runs/46135949197)** for source commit `2eeb717bdbc8bd352f44aa66a485feec2652e47b`. The installer and portable executable built successfully. Native compilation/self-test, package verification, helper enumeration, and unpacked/portable startup and feature checks all passed. Both reports recorded no renderer errors. |
| Live microphone, speech servers, and model loading | Tests use controlled audio/device/provider behavior. Physical microphone recording, live whisper.cpp/OpenAI/custom transcription, and cold-loading real Ollama/LM Studio models still require hands-on checks. |
| Windows conversation protection | **Passed in both packaged forms.** The check used actual Windows protection to encrypt a fixture conversation, restored it through a fresh application core, and verified that Clear chat removed the saved conversation. A full process restart/upgrade and real user profile remain separate manual checks. |
| Microphone and model activity | **Passed in both packaged forms.** Synthetic microphone input travelled through the actual recorder, WAV conversion, and loopback transcription endpoint into an editable unsent draft. The recording tracks stopped, and no extra chat request occurred. A loopback Ollama fixture verified the loading stage and indeterminate bar. |
| Compact layout and visual review | The text box, Record/Stop, and Send controls stayed within the client viewport in idle, loading, recording, and transcript-notice states. The Voice & memory tab opened correctly. The portable build's Windows screenshots at **1008 × 655** were inspected and confirmed the corrected layout. This does not cover every display size or scale setting. |

### Preserved version 0.1.1 evidence

| Area | Recorded result |
|---|---|
| Automated source tests | **80 of 80 tests pass** in the development workspace for the 0.1.1 changes. They cover permissions and cancellation, profile/history separation, credential binding, provider requests, local-model checks, error redaction, native protocol validation, VRM validation, and packaging-related logic. |
| Provider and native test scope | Automated source tests use controlled provider responses and simulated native transports. They do not establish live account access, model compatibility, or actual Windows window behavior. |
| Windows build and packaged startup | **Passed in [Windows build 2](https://github.com/CHagenlo/desktop-anime-bot/actions/runs/46130508477)** for source commit `663f193015d4fd1b2a219a6bb55634fe36320643`. Both executable packages built; native compilation/self-test, seven packaged renderer modules, helper enumeration, and unpacked/portable startup checks passed. Both startup reports recorded no renderer errors. |
| Initial visual rendering | The portable build's saved Windows screenshots were inspected: the settings window initialized and the original default character was visible. This covers initial appearance, not every UI control, animation, or display configuration. |
| Tester desktop and live AI | Hands-on installer use, desktop interaction, actual AI requests, and a user's own avatar/voice have not been verified. No real API keys or sensitive work content were used for these source tests. |

Check the [Windows workflow](https://github.com/CHagenlo/desktop-anime-bot/actions/workflows/windows-build.yml) for the exact source commit and its results. Downloads appear in [Releases](https://github.com/CHagenlo/desktop-anime-bot/releases) only after the required Windows gates succeed. Build 5 verifies the 0.2.0 source snapshot named above; the earlier run records 0.1.1 separately. Later documentation-only updates do not change those executable packages.

## Gates before a test release

The workflow runs on pushes to `main` and supports a manual run. The Windows job first builds and verifies an unpacked app, then runs its startup/feature smoke checks. It creates the installer and portable executable from that verified directory and repeats the smoke checks through the portable launcher. Only successful builds upload the downloadable packages; the publish job rechecks their checksums before creating a test prerelease.

| Gate | What it checks | What it does not establish |
|---|---|---|
| Source checks and automated tests | JavaScript syntax, required files, markup references, local imports, import-map CSP hash, dependency/lock agreement, and the automated source test suite, including memory, microphone permissions/lifecycle, WAV/transcription validation, and local-model loading protocols. | Physical microphone behavior, live provider responses, or real window actions. |
| Native compilation | Compiles the x64 .NET Framework helper, checks its Windows executable architecture, and runs its JSON protocol self-test. | Correct behavior with every Windows application. |
| Package verification | Checks required files inside `app.asar`, the renderer's dependency graph including Three.js add-ons, exclusion of development/runtime files, and equality of the packaged helper with the compiled helper. | Complete UI behavior or visual quality. |
| Packaged native helper | Starts the real packaged helper and requests window enumeration on the Windows runner. | Moving, resizing, minimizing, restoring, undoing, or capturing a user's windows. |
| Unpacked and portable startup smoke | Launches each packaged form with its own disposable profile; checks settings/preload availability, initial paused state, provider choices, character rendering signals, native enumeration, and encryption/decryption of a fixed dummy string. It also saves settings and character window images. | Interactive installation, upgrade/migration, real API-key use, live chat, animation quality, or every UI control. |
| Packaged conversation persistence | Uses actual Windows protection to save a fixture conversation, checks that the file excludes its plaintext, constructs a fresh application core from the same profile, verifies restoration and paused state, and checks Clear chat followed by another fresh core. | A new operating-system process, user-account migration, upgrade, or a real person's conversation/keys. |
| Packaged local-model activity | A loopback Ollama protocol fixture holds the load response until the settings UI visibly shows Loading and an indeterminate bar, then returns a fixture reply and checks that activity clears. | Real model weights, GPU/memory use, load performance, or a live Ollama/LM Studio server. |
| Packaged microphone-to-draft flow | Checks denial before a recording grant, then uses Chromium's synthetic input through the actual MediaRecorder, 16 kHz WAV conversion, and a loopback transcription fixture. Checks stopped tracks, an editable unsent draft, and no extra chat request. | A physical microphone, Windows device-driver behavior, speech recognition accuracy, or a live speech service. |
| Chat control visibility | Checks that the text box, microphone control, and Send button fit within the client viewport initially, during loading and recording, and after transcription. Checks that the Voice & memory tab becomes visible and waits for rendered frames before its screenshot. | Every display size, Windows scaling setting, or possible length of user content. |
| Download verification | Checks both generated executable files, records SHA-256 checksums and package metadata, and rechecks the downloaded artifacts before publishing. | Signing, Windows reputation clearance, or an interactive installer/uninstaller test. |

Smoke checks use temporary profiles separate from the normal `%APPDATA%\DesktopAnimeBot` profile. Synthetic audio is enabled only for diagnostic `--smoke-test` launches. The checks use loopback speech/model fixtures and do not contact a real AI account or open a person's microphone. Reports, process logs, and settings/character/loading/recording/voice screenshots are saved under `dist/smoke/` and uploaded to the workflow's `windows-smoke-reports` artifact when available. The release downloads include `SHA256SUMS.txt` and `package-verification.json`. A failed required gate prevents that run from publishing a new test release.

These are unsigned test builds. Passing CI does not provide code signing or establish readiness for sensitive daily use.

## Reproduce the developer checks

Use Windows x64 with Node.js 22.12.0 or later, npm, and .NET Framework 4.8 or later. From the project directory:

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd test
npm.cmd run package:win
npm.cmd run smoke:windows
node scripts/smoke-windows.cjs "dist/Desktop-Anime-Bot-Portable-0.2.0-x64.exe" portable
```

`package:win` compiles the helper, builds the installer and portable executable, and verifies their packaged contents. `smoke:windows` checks the unpacked application; the final command checks the portable launcher. For an unpacked build only, use `npm.cmd run package:win:dir`.

These commands are for developers. Users of the downloaded installer or portable executable do not need Node.js, npm, or PowerShell setup.

## Windows checks still requiring hands-on validation

| Area | Outstanding verification |
|---|---|
| Installer lifecycle | Interactive installation, desktop/Start menu shortcuts, upgrade behavior, uninstall, and retention of the normal user profile. |
| Portable use | Launching from different folders and use alongside the installed copy with the shared AppData profile. |
| UI and desktop controls | Settings layout, interactive controls, tray behavior, click-through transparency, drag interaction, head pats, shortcuts, and pause/resume. |
| Window integration | Real target matching, perching, movement, resize, minimize, restore, and undo against disposable test windows. |
| Capture | `PrintWindow` output across supported/unsupported applications, scaling, occlusion, and multiple displays. |
| Credentials and persistence | Real chat and separate transcription keys protected with Windows `safeStorage`; a full process restart, upgrade, disabled mode, and expected restrictions under a different Windows account. Packaged checks use a dummy credential string and fixture conversation data. |
| Providers | Live discovery, text replies, image requests, account/model access, latency, and real service failures. |
| Local runtimes | Installed Ollama/LM Studio versions, actual local/vision model metadata, cold/warm loading, elapsed status, load timeout, and cancellation while the server may continue loading. |
| Microphone and transcription | Physical input device selection, Windows permission denial, recording/stop/discard, the 60-second limit, local whisper.cpp v1.9.1+ and hosted/custom service responses, and draft-only insertion with no automatic chat submission. |
| Avatar and voice | A user-owned VRM rig, its textures/expressions, local system speech, and resource use on the target PC. |

### First Windows validation session

Use a disposable, non-sensitive window for the initial desktop checks:

1. Start the app and confirm that it is paused. Configure a profile, then explicitly resume.
2. Add the test app with every permission off. Confirm actions remain unavailable. Mark it Protected and verify that capability switches do not override that rule.
3. Allow only Layout, select the test window, and check perching while moving the window. Verify that manually dragging the character detaches her.
4. Allow Actions and try move, resize, minimize, restore, and undo. Check the actual window after each operation.
5. For an image-capable connection, allow Contents and check the displayed destination before requesting one description. Unsupported capture should fail with an error and no desktop fallback.
6. Change a capability or target while a request is pending. Confirm it cancels and that a late result does not reappear as a new action.
7. Check Work/Play restoration, protected-app precedence, launch-paused behavior after restart, and pause/hide/quit controls.
8. Import an appropriate VRM and exercise head pats, dragging, captions, and optional local speech.
9. Configure microphone input in Voice & memory. Confirm the displayed audio destination, record a harmless phrase, stop, and edit the draft before sending. Check Discard, permission denial, and cancellation during transcription. Verify that local-only mode blocks hosted/custom transcription.
10. With memory on, send a text conversation, restart, and check that it returns only for the same profile. Clear that chat and restart again. Check Clear all conversations and both memory-switch transitions; messages sent while saving is off must not reappear after enabling it.
11. Test a cold and an already loaded local model. Confirm checking/loading/generating stages and an indeterminate bar with elapsed time. Cancel during loading and verify that a late response never appears; the server may retain or finish loading its model.

Distributed builds require the compiled helper at `resources/native/desktop-window-helper.exe`; they do not execute the source PowerShell loader. Source development may use that loader if the development helper has not been compiled, subject to the machine's normal script policy. The application does not override that policy.

## Current implementation limits

- Windows packages target x64. Windows on ARM has not been verified.
- No code signing or automatic updater is included.
- Responses arrive in full; the event named `chat-delta` currently receives the complete response once.
- Microphone input is an explicit recording/transcription workflow, with recordings limited to 60 seconds and an editable draft before Send. It is not always listening or a continuous voice conversation.
- Speech transcription needs a separately running local server/model or a configured hosted/custom service. It is not bundled into the installer.
- Persistent memory retains bounded, completed text turns per profile. It does not save raw audio, screen captures, screenshot-description questions/answers, or draft text. It does not summarize unlimited history into permanent facts.
- The current local-model load interfaces provide stages, not completion percentages. Canceling the client does not promise to unload or stop work already accepted by a model server.
- No autonomous window control, continuous capture, arbitrary shell execution, app typing, or window closing.
- Capture is an isolated selected-window attempt and depends on the target application's rendering support.
- The original test avatar uses procedural animation and approximate mouth movement.
- Local-only mode validates endpoints and runtime metadata. It does not constrain the local model server's own network access.
- No independent security audit or claim that this prototype is ready to handle sensitive work content.
