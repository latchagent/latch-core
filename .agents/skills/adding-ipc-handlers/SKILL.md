---
name: adding-ipc-handlers
description: Adds new IPC channels connecting Electron main process to renderer. Covers the 4-file dance (types, preload, main handler, renderer call) and push-event listeners. Use when adding new features that need renderer-to-main communication or main-to-renderer events.
---

# Adding IPC Handlers

Every feature that crosses the main/renderer boundary touches 4 files in a fixed order.

## Channel naming

All channels follow `latch:<module>-<action>`:

```
latch:pty-create       latch:session-list
latch:policy-save      latch:settings-get
latch:docker-start     latch:mcp-sync
```

## Return shape

Every handler returns `{ ok: boolean; error?: string; ...data }`:

```typescript
return { ok: true, harnesses }
return { ok: false, error: err?.message || 'Something failed.' }
```

## The 4-file flow

### 1. Types — `src/types/index.ts`

Add the method signature to the `LatchAPI` interface:

```typescript
// In the LatchAPI interface:
myFeatureList(): Promise<{ ok: boolean; items: MyItem[]; error?: string }>
myFeatureSave(payload: { item: MyItem }): Promise<{ ok: boolean; error?: string }>
```

### 2. Preload — `src/preload/index.ts`

Expose via `contextBridge`. One-liner invoke wrapper:

```typescript
myFeatureList: () =>
  ipcRenderer.invoke('latch:myfeature-list'),

myFeatureSave: (payload: { item: object }) =>
  ipcRenderer.invoke('latch:myfeature-save', payload),
```

### 3. Main handler — `src/main/index.ts`

Register inside `app.whenReady()`. Follow this exact pattern:

```typescript
ipcMain.handle('latch:myfeature-list', async () => {
  if (!myStore) return { ok: false, error: 'MyStore unavailable' }
  return myStore.listItems()
})

ipcMain.handle('latch:myfeature-save', async (_event: any, payload: any) => {
  try {
    return myStore.saveItem(payload.item)
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Save failed.' }
  }
})
```

Key rules:
- Always `async`
- First param `_event` (unused, underscore prefix)
- Destructure payload in the signature or body
- Guard store availability before use
- Wrap in try/catch, return `{ ok: false, error }` on failure

### 4. Renderer — component or Zustand action

Call with optional chaining guards:

```typescript
const result = await window.latch?.myFeatureList?.()
if (result?.ok) {
  // use result.items
}
```

In Zustand actions (`src/renderer/store/useAppStore.ts`):

```typescript
loadMyFeature: async () => {
  try {
    const result = await window.latch?.myFeatureList?.()
    if (result?.ok) {
      set({ myItems: result.items })
    }
  } catch (err) {
    console.error('Failed to load my feature:', err)
  }
},
```

## Push events (main → renderer)

For events the main process pushes to the renderer (like PTY data or activity events):

**Main process** — emit via `sendToRenderer`:

```typescript
sendToRenderer('latch:myfeature-update', { id, status })
```

**Preload** — expose a listener that returns an unsubscribe function:

```typescript
onMyFeatureUpdate: (callback: (payload: { id: string; status: string }) => void) => {
  const handler = (_event: any, payload: any) => callback(payload)
  ipcRenderer.on('latch:myfeature-update', handler)
  return () => { ipcRenderer.removeListener('latch:myfeature-update', handler) }
},
```

**Renderer** — subscribe in `useEffect`, clean up on unmount:

```typescript
useEffect(() => {
  const unsub = window.latch?.onMyFeatureUpdate?.((payload) => {
    // handle event
  })
  return () => { unsub?.() }
}, [])
```

## Checklist

1. Add method signature to `LatchAPI` in `src/types/index.ts`
2. Add preload wrapper in `src/preload/index.ts`
3. Add `ipcMain.handle()` in `src/main/index.ts`
4. Call from renderer with `window.latch?.method?.()`
5. For push events: add `sendToRenderer` call + `onX` listener + `useEffect` cleanup
