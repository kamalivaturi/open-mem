# Privacy Policy

_Last updated: 2 November 2026_

open-mem is free, open-source software that runs on your own computer. It has no servers, no accounts, no analytics and no telemetry. This policy explains what the software stores, what (if anything) leaves your machine, and how you stay in control. It covers the open-mem software and this GitHub repository.

## Summary

- **Your data stays on your machine.** Everything is stored in one folder, `~/.open-mem` (or wherever `OPEN_MEM_HOME` points).
- **The maintainer never receives your data.** open-mem has no backend and sends nothing to the project or its author.
- **Only the model you choose sees anything**, and only to turn your session into short memories. With Ollama, nothing leaves your computer at all.
- **Secrets are removed first.** API keys, tokens, passwords and similar values are redacted before anything is stored or sent.
- **You can see, search and delete everything** in the web GUI, or delete the whole folder.

## What open-mem stores

While you use Claude Code with the open-mem plugin, it saves the following in a local SQLite database (`~/.open-mem/open-mem.db`):

| Data | Why | Notes |
|---|---|---|
| Your prompts to Claude | Context for memories and session handoffs | Redacted, clipped to 4,000 characters |
| Tool calls Claude makes (inputs and outputs, e.g. file edits, commands) | Raw material for memories | Redacted, clipped to 2,000/3,000 characters; marked processed once compressed |
| Memories ("observations") | What Claude recalls in future sessions | Short summaries written by your observer model |
| Session summaries | Start-of-session handoff | One per session |
| Project name and working folder | Keep memories per project | Taken from the folder or git root name |
| Embeddings (lists of numbers) | Semantic search | Only when an embedding model is configured |

It also keeps `settings.json` (your configuration, including an API key if you enter one), `open-mem.log` (error messages) and `last-drain.json` (the result of the last processing run) in the same folder.

open-mem does **not** collect your name, email, IP address, location, device identifiers or usage statistics.

## What leaves your machine

open-mem itself makes network requests only to the destinations you configure:

| Your setting | Where session data goes |
|---|---|
| `provider: "ollama"` (default) | Your local Ollama server (`127.0.0.1` by default). **Nothing leaves your computer.** |
| `provider: "claude"` | Anthropic, through your own Claude Code login (`claude -p`), under your existing agreement with Anthropic. |
| `provider: "openai"` | The OpenAI-compatible service you configure (for example OpenRouter, Google Gemini or Groq), under that provider's own terms and privacy policy. |
| `embedModel` | Your Ollama server, for semantic search. |

What is sent: batches of redacted tool calls with your latest prompt (to write memories), and your prompts plus existing memories for a session (to write its summary). Please read the privacy terms of any third-party provider you choose, and prefer Ollama when your work is sensitive.

Claude Code itself already sends your conversation to Anthropic as part of normal use. open-mem doesn't change that. It only adds the start-of-session memory text to the context Claude Code sends.

## Redaction and exclusions

Before anything is stored or sent, open-mem removes:

- API keys and tokens (Anthropic/OpenAI-style `sk-…`, GitHub, AWS, Slack, Google keys)
- JWTs and `Bearer` tokens
- Private key blocks
- Passwords and credentials embedded in URLs
- Values of `password=`, `secret:`, `token=`, `api_key=` and similar assignments
- Anything you wrap in `<private>…</private>`

You can also list tools that should never be recorded (`skipTools`, for example `mcp__gmail*`). Redaction is pattern-based and can't catch every possible secret. Avoid pasting secrets into prompts where you can.

## Obsidian

If you set `obsidianDir`, open-mem writes session notes as markdown files into that folder. It never writes anywhere else in your vault. If you set `vaultDir`, Claude can **read** markdown notes in that folder through the `vault_search` tool. The results become part of the Claude conversation, so they are sent to Anthropic like anything else Claude reads. Leave `vaultDir` empty to keep your vault private from Claude.

## The web GUI

The GUI (`open-mem viewer`) is served only on `127.0.0.1`, so other devices on your network can't reach it. It rejects requests with foreign Host headers (DNS-rebinding protection), requires a custom header for every change so other websites can't modify your data, and never sends your API key back to the browser. Its font (Inter) is bundled, so it makes no requests to font CDNs. It stores only your theme choice in your browser's local storage.

## Your control

- **View and search:** the web GUI, the `search` CLI command, or the MCP tools.
- **Delete one memory:** open it in the GUI and choose **Delete**.
- **Delete everything:** remove the `~/.open-mem` folder (and any notes in your `obsidianDir`).
- **Pause recording:** disable the plugin in Claude Code (`/plugin`), or set the environment variable `OPEN_MEM_DISABLE=1`.
- **Uninstall:** `claude plugin uninstall open-mem@open-mem`, then delete `~/.open-mem`.

## Data security

Data is stored unencrypted on your disk, protected by your operating system account like your other files. Use full-disk encryption (BitLocker, FileVault, LUKS) if your device may be lost or shared.

## This repository and links

This project is hosted on GitHub. Visiting or using the repository is governed by [GitHub's Privacy Statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement). The "Buy me a coffee" link goes to buymeacoffee.com, a third-party service with its own privacy policy. open-mem doesn't share any data with it. The README badges are images served by shields.io when you view the README on GitHub; the installed software doesn't load them.

## Children

open-mem is a developer tool and isn't directed at children under 13.

## Changes

Changes to this policy are made in this file and are visible in the repository's commit history. The "Last updated" date above is changed with each revision.

## Contact

Questions or concerns: open an issue at <https://github.com/kamalivaturi/open-mem/issues>.
