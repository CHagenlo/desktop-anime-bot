# Verification status

This record applies to **Desktop Anime AI Companion 0.1.1**, including its Windows installer and portable packaging. It distinguishes completed checks from the release gates defined in source and the Windows behavior that still needs testing.

## Evidence recorded so far

| Area | Recorded result |
|---|---|
| Automated source tests | **80 of 80 tests pass** in the development workspace for the 0.1.1 changes. They cover permissions and cancellation, profile/history separation, credential binding, provider requests, local-model checks, error redaction, native protocol validation, VRM validation, and packaging-related logic. |
| Provider and native test scope | Automated source tests use controlled provider responses and simulated native transports. They do not establish live account access, model compatibility, or actual Windows window behavior. |
| Windows build and packaged startup | **Passed in [Windows build 2](https://github.com/CHagenlo/desktop-anime-bot/actions/runs/46130508477)** for source commit `663f193015d4fd1b2a219a6bb55634fe36320643`. Both executable packages built; native compilation/self-test, seven packaged renderer modules, helper enumeration, and unpacked/portable startup checks passed. Both startup reports recorded no renderer errors. |
| Initial visual rendering | The portable build's saved Windows screenshots were inspected: the settings window initialized and the original default character was visible. This covers initial appearance, not every UI control, animation, or display configuration. |
| Tester desktop and live AI | Hands-on installer use, desktop interaction, actual AI requests, and a user's own avatar/voice have not been verified. No real API keys or sensitive work content were used for these source tests. |

Check the [Windows workflow](https://github.com/CHagenlo/desktop-anime-bot/actions/workflows/windows-build.yml) for the exact source commit and its results. Downloads appear in [Releases](https://github.com/CHagenlo/desktop-anime-bot/releases) only after the required Windows gates succeed. The recorded passing run verifies that source snapshot; later code changes require their own successful checks.

## Gates before a test release

The workflow runs on pushes to `main` and supports a manual run. Its Windows job must pass these checks before uploading the downloadable packages; the publish job then verifies the downloaded checksums before creating a test prerelease.

| Gate | What it checks | What it does not establish |
|---|---|---|
| Source checks and automated tests | JavaScript syntax, required files, markup references, local imports, import-map CSP hash, dependency/lock agreement, and the automated source test suite. | Actual Electron rendering, live provider responses, or real window actions. |
| Native compilation | Compiles the x64 .NET Framework helper, checks its Windows executable architecture, and runs its JSON protocol self-test. | Correct behavior with every Windows application. |
| Package verification | Checks required files inside `app.asar`, the renderer's dependency graph including Three.js add-ons, exclusion of development/runtime files, and equality of the packaged helper with the compiled helper. | Complete UI behavior or visual quality. |
| Packaged native helper | Starts the real packaged helper and requests window enumeration on the Windows runner. | Moving, resizing, minimizing, restoring, undoing, or capturing a user's windows. |
| Unpacked and portable startup smoke | Launches each packaged form with its own disposable profile; checks settings/preload availability, initial paused state, provider choices, character rendering signals, native enumeration, and encryption/decryption of a fixed dummy string. It also saves settings and character window images. | Interactive installation, upgrade/migration, real API-key use, live chat, animation quality, or every UI control. |
| Download verification | Checks both generated executable files, records SHA-256 checksums and package metadata, and rechecks the downloaded artifacts before publishing. | Signing, Windows reputation clearance, or an interactive installer/uninstaller test. |

Smoke checks use temporary profiles separate from the normal `%APPDATA%\DesktopAnimeBot` profile. Their reports, window images, and process logs are saved under `dist/smoke/` and uploaded to the workflow's `windows-smoke-reports` artifact when available. The release downloads include `SHA256SUMS.txt` and `package-verification.json`. A failed required gate prevents that run from publishing a new test release.

These are unsigned test builds. Passing CI does not provide code signing or establish readiness for sensitive daily use.

## Reproduce the developer checks

Use Windows x64 with Node.js 22.12.0 or later, npm, and .NET Framework 4.8 or later. From the project directory:

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd test
npm.cmd run package:win
npm.cmd run smoke:windows
node scripts/smoke-windows.cjs "dist/Desktop-Anime-Bot-Portable-0.1.1-x64.exe" portable
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
| Credentials and persistence | A real API key protected with Windows `safeStorage`, restart/upgrade behavior, and expected restrictions under a different Windows account. The smoke check uses only a dummy string. |
| Providers | Live discovery, text replies, image requests, account/model access, latency, and real service failures. |
| Local runtimes | Installed Ollama/LM Studio versions and actual local/vision model metadata. |
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

Distributed builds require the compiled helper at `resources/native/desktop-window-helper.exe`; they do not execute the source PowerShell loader. Source development may use that loader if the development helper has not been compiled, subject to the machine's normal script policy. The application does not override that policy.

## Current implementation limits

- Windows packages target x64. Windows on ARM has not been verified.
- No code signing or automatic updater is included.
- Responses arrive in full; the event named `chat-delta` currently receives the complete response once.
- No microphone input, persistent conversational memory, autonomous window control, continuous capture, arbitrary shell execution, app typing, or window closing.
- Capture is an isolated selected-window attempt and depends on the target application's rendering support.
- The original test avatar uses procedural animation and approximate mouth movement.
- Local-only mode validates endpoints and runtime metadata. It does not constrain the local model server's own network access.
- No independent security audit or claim that this prototype is ready to handle sensitive work content.
