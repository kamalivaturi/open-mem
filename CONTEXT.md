# open-mem domain language

Use these words for these things in code, docs and reviews.

- **Session**: one Claude conversation. Live ones are recorded by hooks; past ones come from Claude's own transcripts or a claude.ai export.
- **Surface**: where a Session happened: Claude Code CLI, Claude Desktop (Code tab), Claude Cowork, claude.ai.
- **Observation**: one compressed, typed memory (`bugfix`, `decision`, …) written by the Observer from a batch of tool calls.
- **Handoff**: the summary written when a Session stops (request, completed, learned, next steps), injected at the next session start.
- **Observer**: the model that writes Observations, Handoffs and Purposes (Ollama, the Claude plan, or an OpenAI-compatible API).
- **Drain**: the background run that turns queued tool calls into Observations, writes Handoffs and Purposes, and syncs every Source.
- **Source**: an adapter the ingestion module reads from: the Obsidian vault, Claude transcripts, scheduled tasks, projects, a claude.ai export. It only lists items and parses one.
- **Item**: anything ingested from a Source, stored once in `items` with a kind: `note`, `session`, `task`, `project` (and `background`, a text-free record of an automated run, kept only as evidence of where Claude worked).
- **Retained source**: a Source whose Items stay when they vanish upstream (marked missing), because open-mem is the archive: Claude transcripts, scheduled tasks, projects, chats. A **mirrored** source (the vault) deletes them.
- **Purpose**: the Observer's "purpose and intention" description of a project or scheduled task, rewritten only when its material changes.
