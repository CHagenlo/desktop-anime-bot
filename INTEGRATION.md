# Prototype integration contract

The root agent owns Electron main/preload, configuration, permission policy, package files and final documentation. Other owners modify only their allocated files. JavaScript uses native modules for core (`.mjs`), CommonJS for Electron entry/preload (`.cjs`), and plain browser modules for renderers. No TypeScript/bundler is required.

## Config (public; never contains API keys)

```js
{
  version: 1,
  activeConnectionId: '',
  connections: [{id, name, provider, baseUrl, model, supportsVision:false,
    workspaceId:'', anthropicVersion:'', hasKey:false}],
  privacy: {localOnly:false, reactToWindows:true, seeWindowContents:false,
    manageWindows:false, paused:false, mode:'custom',
    rules:[{exePath, label, protected:false, layout:false, vision:false, manage:false}]},
  character: {name:'Companion', personality:'Warm, curious and gently playful. Be concise.',
    playfulness:'balanced', speechEnabled:false, modelName:''}
}
```

`hasKey` is computed only for public UI snapshots. Provider changes never carry conversation or screenshots into a different connection; messages are kept in memory only. Screen-image requests are single-turn and never appended to chat history. Protected app rules override every mode. Pause and permission/provider changes revoke pending operations.

## `src/providers/index.mjs` interface

Exports:
- `PROVIDER_PRESETS`: array of `{id,label,baseUrl,kind:'hosted'|'local'|'custom',keyRequired:boolean}`. Provider IDs: openai, anthropic, gemini, xai, deepseek, mistral, ollama, lmstudio, compatible.
- `validateConnection(connection, {localOnly=false}={})`: return normalized public connection or throw. HTTPS for hosted/custom except loopback local HTTP; no URL username/password/query/hash. No hard-coded model IDs. Credentials are bound to each connection endpoint by root's secret store.
- `listModels(connection, {apiKey='',signal,localOnly=false,fetchImpl=fetch}={})`: returns `[{id,name,supportsVision:null|boolean,remote:boolean}]`. Successful discovery is not proof of chat/vision compatibility.
- `generateReply(connection, {apiKey='',messages,system='',image:null|{mimeType:'image/png',base64},signal,localOnly=false,fetchImpl=fetch,onDelta}={})`: Promise<string>. `messages` is an array of `{role:'user'|'assistant',content:string}`. Image attaches to the latest user message, gated on `connection.supportsVision === true`. No tools/shell execution. No cross-provider fallback. Abort is honored. If implementing streaming, onDelta receives text fragments; return full assembled text. Optional fetch injection makes offline protocol tests possible.

Keys stay only in the main process. Error text must not contain keys, full provider response bodies, or screenshots. Native provider storage options should favor stateless requests where documented.

## `src/native/windows.mjs` interface

Exports class `WindowsBridge` with methods:
- `listWindows(): Promise<WindowInfo[]>`
- `inspectWindow(handle): Promise<WindowInfo>`
- `performAction(target, action): Promise<WindowInfo>` where action is `{type:'move',dx,dy}` or `{type:'resize',width,height}` or `{type:'minimize'|'restore'}`. Root handles permissions and Undo; no close action in this prototype.
- `captureWindow(target): Promise<{mimeType:'image/png',base64}>` only if selected-window isolation is supported. Never fall back to full-desktop capture. Clear unsupported/failure errors are acceptable and must be documented.
- `dispose(): void`

WindowInfo: `{handle:string,pid:number,exePath:string,processName:string,title:string,bounds:{x,y,width,height},minimized:boolean}`. The native helper must recheck expected PID, executable path and title immediately before capture/actions. Reject its own process windows through a configurable excluded PID or let root filter. No arbitrary commands. Windows-only methods must report unsupported on other OSs. Do not execute PowerShell or modify policies in this Linux workspace.

## `window.companion` preload API (promises unless noted)

- `getState()` -> `{config,providers,platform,selectedWindow:null|WindowInfo,status:{nativeAvailable:boolean,nativeMessage:string},messages:[]}`.
- `savePreferences({privacy?,character?})` -> state. Privacy only allows the known scalar fields; app rules have dedicated methods.
- `saveConnection({id?,name,provider,baseUrl,model,supportsVision,workspaceId?,anthropicVersion?,apiKey?,removeKey?})` -> state. Blank apiKey keeps existing only for unchanged provider/endpoint; endpoint changes require a new key. Saving selects this connection.
- `selectConnection(id)` -> state. `removeConnection(id)` -> state.
- `listModels(connectionId)` -> model array.
- `sendMessage({text})` -> `{text}`. Stream events arrive through `onEvent`.
- `clearChat()` -> state; `cancelReply()`.
- `listWindows()` -> WindowInfo[]. `selectWindow(handle)` -> state.
- `saveRule({exePath,label,protected,layout,vision,manage})` -> state.
- `describeWindow({question})` -> `{text}`; uses current selected window and current connection.
- `windowAction({type:'move',dx,dy}|{type:'resize',width,height}|{type:'minimize'|'restore'|'undo'})` -> state. These are user-issued buttons/commands only; model text cannot invoke them.
- `importAvatar()` -> `{name}` or null. `getAvatar()` -> `{name,bytes:number[]}` or null; file is a self-contained `.vrm` model. Root validates file and returns bytes only.
- `openSettings()`, `toggleOverlay()`, `quit()`, `pauseAll()` -> state.
- `setOverlayInteractive(boolean)` -> void; `dragOverlay({phase:'start'|'move'|'end',screenX,screenY})` -> void.
- `onEvent(callback)` -> unsubscribe function. Events: `{type:'state',state}`, `{type:'chat-delta',text}`, `{type:'chat-reply',text}`, `{type:'status',text}`, `{type:'cursor',x,y}` (x/y in overlay window coordinates), `{type:'pose',pose:'idle'|'perched'|'thinking'|'speaking'|'paused'}`, `{type:'dragging',active:boolean}`.

## Renderer files

`renderer/settings.html`, `settings.css`, `settings.js`: actual Electron control window with tabs Chat / AI connections / Desktop privacy / Character. No fake successful API connection state. Public provider config only. Keys are entered once and cleared after save. Text responses must use textContent. Show explicit destination for screenshots and no cloud fallback. An unavailable feature must be described honestly.

`renderer/overlay.html`, `overlay.css`, `overlay.js`: transparent always-on-top character surface. Optional import of a user-owned VRM using `three` and `@pixiv/three-vrm`. Provide a clearly labeled simple procedural placeholder when no model is imported. Cursor look, idle, drag/pat, mouth motion and simple perch pose are sufficient prototype behaviors. Do not fetch remote assets. ES-module import map can map `three`, `three/addons/`, and `@pixiv/three-vrm` to packaged node_modules via relative paths. Root adds npm dependencies after version verification.

All UI must work as source after npm install on Windows. No real API credentials or third-party model files are supplied. No claims of a completed polished character, realtime voice recognition, or Windows runtime testing in this Linux build environment.
