# The collections domain owns its model rules and mutations

## Decision

`collections.js` is the single owner of the collection model:

- `resolveDefaultCollection(defaults, sessionId)` — per-session override wins, else global, else none.
- `defaultEntryTitle(entry)` — stored title, else first non-empty line of content, else of raw, else `Chunk N` (capped at 120 chars).
- Serialized mutations over the store: CRUD, entry add/remove/title/content, `reorderEntries`, `clearCollectionEntries`, defaults set/merge — with validation and the delete-cleans-defaults cleanup.
- Worker message handlers for collections are one-line delegations into the module.

## Context

The domain used to live in three contexts: mutations in the service worker, the defaults rule in chunks.js, rendering/export in options.js. The rule was re-spelled in four places and drifted — a failed session-default save restored `''` over a global default, pinning a duplicate per-session entry that shadowed the global. The mutator truthy-overload ("return true = skip write") also leaked `alreadyPresent` through the message interface.

## Consequences

- The defaults rule and title convention are owned once; chunks.js and options.js consume them.
- `alreadyPresent` is now a `{ changed: false, note }` outcome carried back explicitly as a field on the response.
- Validation lives with the mutation, not at the call site — the worker handlers contain no collection logic.
- One module to test (`tests/collections.test.js`).
