---
name: enclave-data-classifier
description: LLM-assisted data classification for the Latch Enclave proxy. Covers prompt building, response parsing, tier validation, and the DataClassifier class. Use when working on data classification, sensitivity tiers, content analysis, or LLM-driven data labeling in the enclave pipeline.
---

# Data Classifier

The data classifier provides LLM-assisted classification of API response bodies
into sensitivity tiers. It is advisory only -- classifications are proposals that
the user must review before they are promoted to service definition patterns.

**Design principle: propose only, never enforce.**

---

## Module: `src/main/services/data-classifier.ts`

### Exported functions

#### `buildClassificationPrompt(body, serviceId, contentType)`

Builds the LLM prompt for classifying a response body.

- **body** (`string`) -- The raw response body to classify.
- **serviceId** (`string`) -- The service ID (e.g. `"github"`).
- **contentType** (`string`) -- The Content-Type header value (e.g. `"application/json"`).
- **Returns** `string` -- The full prompt text.

Key behavior:
- Truncates the body at 4000 characters to stay within token limits.
- Appended excerpt is wrapped in a fenced code block.
- Prompt instructs the LLM to respond with a JSON object containing `suggestedTier`, `confidence`, `patterns`, and `reasoning`.

#### `parseClassificationResponse(response)`

Parses and validates the LLM's JSON response.

- **response** (`string`) -- Raw LLM output (expected to be JSON).
- **Returns** `DataClassification | null` -- Parsed classification, or `null` if invalid.

Validation rules:
- Must be valid JSON.
- `suggestedTier` must be one of: `public`, `internal`, `confidential`, `restricted`.
- `confidence` must be a number (clamped to 0-1).
- `patterns` defaults to `[]` if not an array.
- `reasoning` is coerced to string.

Returns `null` for any validation failure -- never throws.

### DataClassifier class

```ts
class DataClassifier {
  constructor(apiKey: string | null)
  classify(body: string, serviceId: string, contentType: string): Promise<DataClassification | null>
}
```

- Requires an OpenAI API key; returns `null` if no key is set.
- Uses `gpt-4o-mini` with `temperature: 0.1` and `response_format: { type: 'json_object' }`.
- 15-second request timeout via `AbortSignal.timeout`.
- All errors are caught and return `null` -- never throws.

---

## Types (`src/types/index.ts`)

### DataTier

```ts
type DataTier = 'public' | 'internal' | 'confidential' | 'restricted'
```

### DataClassification

```ts
interface DataClassification {
  suggestedTier: DataTier
  confidence: number       // 0-1
  patterns: string[]       // detected patterns that drove classification
  reasoning: string        // LLM explanation
}
```

---

## IPC handler

### `latch:data-classify`

- **Payload**: `{ body: string; service: string; contentType: string }`
- **Response**: `{ ok: boolean; classification?: DataClassification; error?: string }`
- Registered in `src/main/index.ts`, exposed via preload as `window.latch.classifyData()`.

The DataClassifier singleton is initialized in `app.whenReady()` with the OpenAI API key from settings:

```typescript
const openaiKey = settingsStore?.get('openai-api-key')
dataClassifier = new DataClassifier(openaiKey?.value ?? null)
```

---

## Testing

### `src/main/services/data-classifier.test.ts` (5 tests)

Run: `npx vitest run src/main/services/data-classifier.test.ts`

Covers:
- `buildClassificationPrompt` includes body excerpt and service ID
- `buildClassificationPrompt` truncates bodies longer than 4000 chars (prompt stays under 6000 chars)
- `parseClassificationResponse` extracts tier, confidence, and patterns from valid JSON
- `parseClassificationResponse` returns null for invalid JSON
- `parseClassificationResponse` rejects tiers not in the valid set

---

## Integration with the proxy pipeline

The data classifier sits outside the hot path. It is invoked on-demand (via IPC)
rather than on every proxied response. Typical usage:

1. User inspects a proxied response in the Enclave panel.
2. User clicks "Classify" to invoke `window.latch.classifyData()`.
3. The LLM analyzes the response body and returns a suggested tier.
4. The user reviews the suggestion and optionally updates the service definition's
   `dataTier.defaultTier` or redaction patterns.

This keeps the proxy fast (no LLM latency in the request path) while still
providing intelligent classification assistance.

---

## Custom Service Builder (`src/renderer/components/modals/ServiceEditor.tsx`)

The ServiceEditor modal provides a UI for creating custom services. The data tier
selection in the service editor can be informed by classification results. Users
can classify sample data and use the suggested tier when configuring a new service's
`dataTier.defaultTier`.
