---
name: adding-service-modules
description: Creates business logic and background service modules in the Electron main process. Covers the service class pattern, dependency injection, lifecycle management, renderer event pushing, and co-located testing. Use when adding non-UI, non-store logic such as background workers, API servers, or processing engines.
---

# Adding Service Modules

Services live in `src/main/services/` and contain business logic, background processes, or coordination between stores. They run in the Electron main process.

## Service class template

```typescript
// src/main/services/sync-engine.ts

/**
 * @module sync-engine
 * @description Periodically syncs widget state to an external service.
 */

import type { WidgetStore } from '../stores/widget-store'

export class SyncEngine {
  private widgetStore: WidgetStore
  private sendToRenderer: (channel: string, payload: unknown) => void
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    widgetStore: WidgetStore,
    sendToRenderer: (channel: string, payload: unknown) => void,
  ) {
    this.widgetStore = widgetStore
    this.sendToRenderer = sendToRenderer
  }

  /** Start periodic sync. */
  start(): void {
    this.timer = setInterval(() => this.tick(), 30_000)
  }

  /** Stop the service. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Push status to renderer. */
  private notify(status: string): void {
    this.sendToRenderer('latch:sync-status', { status })
  }

  /** Single sync cycle. */
  private tick(): void {
    try {
      const { widgets } = this.widgetStore.listWidgets()
      // ... sync logic ...
      this.notify('synced')
    } catch {
      // Non-fatal — will retry next cycle
    }
  }
}
```

## Key patterns

### Dependency injection via constructor
Services receive their dependencies (stores, `sendToRenderer`) as constructor arguments. This keeps them testable — tests can pass mocks.

### Lifecycle: start() / stop()
Services with timers or servers implement `start()` and `stop()`. Both are called from `src/main/index.ts`.

### Wire with setters for optional deps
When services have circular or optional dependencies, use setters:
```typescript
authzServer.setRadar(radar)
authzServer.setFeedStore(feedStore)
```

### Push events to renderer
Use `sendToRenderer` (passed via constructor) to emit events:
```typescript
this.sendToRenderer('latch:myservice-event', { data })
```

The renderer subscribes via a preload listener (see `adding-ipc-handlers` skill).

### Never crash the main process
Wrap all logic in try/catch. A service failure must not bring down the app:
```typescript
private tick(): void {
  try {
    // ... work ...
  } catch {
    // Non-fatal — log and retry next cycle
  }
}
```

### Import paths
From `src/main/services/`, imports look like:
```typescript
import type { WidgetStore } from '../stores/widget-store'
import type { SomeType } from '../../types'
```

## Wiring into the app

In `src/main/index.ts`:

```typescript
import { SyncEngine } from './services/sync-engine'

// Inside app.whenReady(), after stores are initialized:
let syncEngine: SyncEngine | null = null

try {
  syncEngine = new SyncEngine(widgetStore, sendToRenderer)
  syncEngine.start()
} catch (err: any) {
  console.error('SyncEngine start failed:', err?.message)
  syncEngine = null
}

// In app.on('before-quit'):
syncEngine?.stop()
```

## Testing

Tests are co-located: `src/main/services/sync-engine.test.ts`.

```typescript
import { describe, it, expect } from 'vitest'
import { SyncEngine } from './sync-engine'

// Factory helper for test fixtures
function makeStore(overrides?: Partial<WidgetStore>) {
  return {
    listWidgets: () => ({ ok: true, widgets: [] }),
    ...overrides,
  } as any
}

describe('SyncEngine', () => {
  it('calls listWidgets on tick', () => {
    let called = false
    const store = makeStore({
      listWidgets: () => { called = true; return { ok: true, widgets: [] } },
    })
    const engine = new SyncEngine(store, () => {})
    // trigger tick manually for testing
    ;(engine as any).tick()
    expect(called).toBe(true)
  })
})
```

Run tests: `npx vitest run src/main/services/sync-engine.test.ts`

### Test conventions
- Use `describe()` / `it()` / `expect()` from vitest
- Create factory helpers (`makeStore`, `makePolicy`, `makeEvent`) for test data
- Group tests by feature in nested `describe` blocks
- Mock dependencies as plain objects with `as any`
- Test exported pure functions directly; test class methods via public API

## Checklist

1. Create `src/main/services/<name>.ts` with JSDoc module header
2. Accept dependencies via constructor (stores, `sendToRenderer`)
3. Implement `start()` / `stop()` for lifecycle services
4. Wrap all work in try/catch — never crash the main process
5. Wire in `src/main/index.ts`: instantiate after stores, call `.start()`, call `.stop()` in `before-quit`
6. Add co-located `.test.ts` file with factory helpers
