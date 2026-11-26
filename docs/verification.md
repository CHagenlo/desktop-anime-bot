# Verification status

This record applies to the current **Desktop Anime AI Companion 0.1.0 source prototype**. It distinguishes checks completed in the build workspace from behavior that still needs testing on Windows.

## Completed

- **70 automated tests pass**, covering core permissions and cancellation, profile/history separation, credential binding, provider request construction, local-model checks, error redaction, native helper protocol validation, and VRM validation.
- Provider tests use controlled mock responses. They make no claim about a real account, paid model access, image quality, latency, or current service availability.
- Native transport tests use simulated helper processes. They verify protocol behavior and rejection paths without executing PowerShell or manipulating Windows applications.
- Both renderer JavaScript files pass syntax checks. Markup IDs and referenced elements were checked; no duplicate IDs or unresolved static element references were found.
- Three.js, `GLTFLoader`, `VRMLoaderPlugin`, and required VRM utilities import from the installed pinned dependencies. The inline import-map CSP hash matches its exact contents.
- The dependency lock records Electron 45.5.0, Three.js 0.187.0, and `@pixiv/three-vrm` 3.6.0. The VRM package's declared Three.js peer range is satisfied.
- The project source check verifies JavaScript syntax, required files, markup references, local import paths, the CSP hash, and pinned dependency/lock agreement.

Run the reproducible checks from the project directory:

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd test
```

Passing these checks does not establish Windows runtime compatibility or replace visual testing.

## Not yet verified

| Area | Outstanding verification |
|---|---|
| Actual UI rendering | Settings layout, all interactive controls, and the rendered 3D character in a running Electron window. No visual runtime verification was obtained. |
| Windows runtime | Startup, tray behavior, click-through transparency, drag interaction, hotkeys, and pause/resume. |
| Window integration | Real enumeration, target matching, perching, movement, resize, minimize, restore, and undo. |
| Capture | Real `PrintWindow` output across supported/unsupported applications, scaling, occlusion, and display configurations. |
| Credentials | A real API key stored and unlocked through Windows `safeStorage`. |
| Providers | Live model discovery, text responses, image input, billing/account access, and failure behavior with real services. |
| Local runtimes | Installed Ollama/LM Studio versions and actual local/vision model metadata. |
| Avatar and voice | A user-owned VRM rig, its textures/expressions, local system speech, and resource use on the target PC. |

## First Windows validation session

Use a disposable, non-sensitive window for the initial desktop checks:

1. Start the app and confirm that it is paused. Configure a profile, then explicitly resume.
2. Add the test app with every permission off. Confirm actions remain unavailable. Mark it Protected and verify that capability switches do not override that rule.
3. Allow only Layout, select the test window, and check perching while moving the window. Verify that manually dragging the character detaches her.
4. Allow Actions and try move, resize, minimize, restore, and undo. Check the actual window after each operation.
5. For an image-capable connection, allow Contents and check the displayed destination before requesting one description. Unsupported capture should fail with an error and no desktop fallback.
6. Change a capability or target while a request is pending. Confirm it cancels and that a late result does not reappear as a new action.
7. Check Work/Play restoration, protected-app precedence, launch-paused behavior after restart, and pause/hide/quit controls.
8. Import an appropriate VRM and exercise head pats, dragging, captions, and optional local speech.

PowerShell policy may legitimately prevent helper startup. Native features remain unavailable in that environment unless the helper is permitted through the machine's normal authorized policy. Do not bypass execution policy to complete this validation.

## Current implementation limits

- Source only: no installer, code signing, automatic updater, or production release pipeline.
- Responses arrive in full; the event named `chat-delta` currently receives the complete response once.
- No microphone input, persistent memory, autonomous window control, continuous capture, arbitrary shell execution, app typing, or window closing.
- Capture is an isolated selected-window attempt, not a universal game/video capture system.
- Avatar motion is procedural and mouth motion approximate; no finished anime asset is supplied.
- Local-only mode validates endpoint and runtime metadata. It is not a firewall or a sandbox for the local model server.
- No independent security audit or claim that this prototype is ready to handle sensitive work content.
