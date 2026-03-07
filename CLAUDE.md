# Agent Orchestrator

## Project Overview
Sequential pipeline of Claude agents for automated software development. An optional Spec Discovery agent refines ideas through conversation, then the task flows through 7 pipeline agents: Product Designer, Test Writer, Frontend Builder, Backend Builder, Code Reviewer, PM, Git Committer.

## Architecture
- `orchestrate.js` — Main pipeline entry point, ES module, uses `@anthropic-ai/sdk`
- `discover.js` — Interactive spec discovery CLI (multi-turn conversation, optional)
- `agents/prompts/*.md` — System prompts for each agent (8 files)
- `workspace/<run-id>/` — Output artifacts per run (gitignored)
- `logs/<run-id>.log` — Full pipeline logs (gitignored)

## Key Patterns
- Each agent gets isolated context (only the inputs it needs)
- Code Reviewer loops up to `MAX_REVIEW_ITERATIONS` (3) times, feeding feedback back to builders
- Two model tiers: `claude-opus-4-6` for complex work, `claude-sonnet-4-6` for simpler tasks
- All agent outputs are written to disk as markdown files in the workspace directory

## Running
```bash
node discover.js --run    # interactive spec discovery, then orchestrate
node orchestrate.js "task description"  # direct orchestration
```
Requires Claude Code CLI (`claude`) to be installed and authenticated. All agent calls use `claude --print` — no separate API key needed.
