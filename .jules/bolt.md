## 2024-05-22 - Storage I/O Bottleneck in Loop
**Learning:** Sequential calls to `browser.storage.local.get/set` inside a loop (100+ iterations) caused a ~1s delay during page initialization. Restoring state from storage shouldn't trigger redundant writes.
**Action:** When restoring UI state from a data source, skip the side-effect of persisting that same data back to storage. Use a `skipStorage` flag or separate UI rendering from data persistence.

## 2024-05-22 - String Concatenation vs Array Join
**Learning:** In this environment (Node/V8), simple string concatenation (`+=`) was significantly faster (4x) than `Array.push` + `join('')` for building large text content from a DOM tree.
**Action:** Don't blindly replace `+=` with `Array.join` for performance. Benchmark first. V8's rope optimization is powerful.
