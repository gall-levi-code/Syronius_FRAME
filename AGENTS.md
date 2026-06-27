## graphify

This project has a local knowledge graph at graphify-out/. Use it as a navigation aid, not a mandatory gate.

When the user types `/graphify`, invoke the `skill` tool with `skill: "graphify"` before doing anything else.

Rules:
- Use `graphify query "<question>"` first for broad architecture/navigation questions when graphify-out/graph.json exists. For direct implementation, debugging, or tests, read the source directly and use graphify only if it will save time.
- Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts.
- Skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying indexed code, run `npm run graphify:update` to keep the graph current (AST-only, no API cost). Skip for docs/config-only edits unless the user asks for a graph refresh.
