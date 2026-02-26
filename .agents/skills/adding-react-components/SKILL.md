---
name: adding-react-components
description: Creates React components for the Electron renderer process, including rail panels, modals, views, and Zustand store wiring. Covers component structure, state management patterns, CSS conventions, and registration. Use when adding new UI to the renderer.
---

# Adding React Components

The renderer uses React 18 with Zustand for state. Components live in `src/renderer/components/`. No barrel files — import directly from the file path.

## Component types

| Type | Location | Root class | Purpose |
|------|----------|------------|---------|
| Panel | `components/panels/` | `.rail-panel` | Side panel in the rail |
| Modal | `components/modals/` | `.modal-backdrop` + `.modal` | Overlay dialogs |
| View | `components/` | `.view-container` | Full-width main views |

## Panel template

```typescript
// src/renderer/components/panels/WidgetPanel.tsx

import { useEffect, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'

export default function WidgetPanel() {
  const { activeSessionId } = useAppStore()
  const [items, setItems] = useState<any[]>([])

  useEffect(() => {
    window.latch?.widgetList?.().then((res) => {
      if (res?.ok) setItems(res.widgets)
    })
  }, [activeSessionId])

  return (
    <div className="rail-panel" id="rail-panel-widget">
      <div className="section-label">Widgets</div>
      {items.map((item) => (
        <div key={item.id} className="card-row">
          <span className="card-row-title">{item.name}</span>
        </div>
      ))}
    </div>
  )
}
```

### Register in Rail.tsx

```typescript
// src/renderer/components/Rail.tsx
import WidgetPanel from './panels/WidgetPanel'

// Add to TABS array:
{ id: 'widget', label: 'Widgets' }

// Add conditional render:
{activeRailPanel === 'widget' && <WidgetPanel />}
```

Add the ID to the `RailPanel` type in `src/types/index.ts`.

## Modal template

```typescript
// src/renderer/components/modals/WidgetEditor.tsx

import { useEffect, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'

export default function WidgetEditor() {
  const {
    widgetEditorOpen,
    widgetEditorWidget,
    closeWidgetEditor,
    saveWidget,
  } = useAppStore()

  const [name, setName] = useState('')

  useEffect(() => {
    setName(widgetEditorWidget?.name ?? '')
  }, [widgetEditorWidget])

  if (!widgetEditorOpen) return null

  const handleSave = async () => {
    if (!name.trim()) return
    await saveWidget({
      id: widgetEditorWidget?.id ?? `widget-${Date.now()}`,
      name: name.trim(),
    })
    closeWidgetEditor()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') closeWidgetEditor()
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSave()
  }

  return (
    <div
      className="modal-backdrop"
      onKeyDown={handleKeyDown}
      onClick={(e) => { if (e.target === e.currentTarget) closeWidgetEditor() }}
    >
      <div className="modal" id="widget-editor-modal">
        <div className="modal-header">
          <span className="modal-title">
            {widgetEditorWidget ? 'Edit Widget' : 'New Widget'}
          </span>
          <button className="modal-close" onClick={closeWidgetEditor}>&times;</button>
        </div>
        <div className="modal-body">
          <div className="modal-field">
            <label className="modal-label" htmlFor="we-name">Name</label>
            <input
              className="modal-input"
              id="we-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={closeWidgetEditor}>Cancel</button>
          <button className="modal-btn is-primary" onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  )
}
```

## Zustand store wiring

In `src/renderer/store/useAppStore.ts`, add state + actions:

```typescript
// State
widgetEditorOpen: false,
widgetEditorWidget: null as WidgetRecord | null,

// Actions
openWidgetEditor: (widget: WidgetRecord | null) => {
  set({ widgetEditorOpen: true, widgetEditorWidget: widget })
},

closeWidgetEditor: () => {
  set({ widgetEditorOpen: false, widgetEditorWidget: null })
},

saveWidget: async (widget: WidgetRecord) => {
  const result = await window.latch?.widgetSave?.({ item: widget })
  if (result?.ok) {
    // reload or update local state
  }
},
```

**Pattern:** Each modal gets `<X>Open`, `<X>Data`, `open<X>()`, `close<X>()`.

**Selecting state:** Use granular selectors to avoid unnecessary re-renders:
```typescript
const widgetEditorOpen = useAppStore((s) => s.widgetEditorOpen)
```

Or destructure when you need multiple values:
```typescript
const { widgetEditorOpen, openWidgetEditor, closeWidgetEditor } = useAppStore()
```

## CSS conventions

All styles live in `src/renderer/styles.css`. Use CSS custom properties:

```css
#rail-panel-widget {
  padding: 12px;
}

#rail-panel-widget .card-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  background: var(--bg-card);
  cursor: pointer;
}

#rail-panel-widget .card-row:hover {
  background: var(--bg-card-hover);
}
```

**Key tokens:** `--bg-card`, `--bg-card-hover`, `--border-subtle`, `--border-active`, `--text-primary`, `--text-secondary`, `--success`, `--warning`, `--error`.

**Modifiers:** Use `.is-*` classes: `.is-active`, `.is-primary`, `.is-danger`.

## Gotchas

- **No StrictMode** — removed to prevent double PTY listener registration. Don't add it back.
- **Always-mounted terminals** — xterm.js panes stay in the DOM, toggled with `display: none/block`. Never unmount them.
- **No barrel files** — import directly: `import WidgetPanel from '../components/panels/WidgetPanel'`
- **Guard IPC calls** — always `window.latch?.method?.()` with optional chaining.

## Checklist

1. Create component file in `src/renderer/components/panels/`, `modals/`, or root
2. Add state + actions to `src/renderer/store/useAppStore.ts` if needed
3. Register in parent (Rail.tsx for panels, App.tsx or parent view for modals)
4. Add `RailPanel` type if adding a rail panel (`src/types/index.ts`)
5. Add styles to `src/renderer/styles.css` using CSS custom properties
6. Import directly — no barrel files
