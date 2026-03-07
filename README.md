# Agent Orchestrator

A sequential pipeline of specialized Claude agents that takes a task description from idea to committed code.

## Pipeline

```
                    +-----------------+
                    | Spec Discovery  |  (interactive, optional)
                    | asks questions  |
                    | until clear     |
                    +--------+--------+
                             |
                     Task Specification
                             |
                             v
                    +--------+--------+
                    | Product Designer| --> PRD
                    +--------+--------+
                             |
                             v
                    +--------+--------+
                    |   Test Writer   | --> Test specifications
                    +--------+--------+
                             |
                             v
                    +--------+--------+
                    |Frontend Builder | --> Frontend code
                    +--------+--------+
                             |
                             v
                    +--------+--------+
                    |Backend Builder  | --> Backend code
                    +--------+--------+
                             |
                             v
                    +--------+--------+
                    | Code Reviewer   | --> SHIP IT / feedback
                    +--------+--------+       |
                             |          (loops back to builders,
                             |           max 3 iterations)
                             v
                    +--------+--------+
                    |       PM        | --> Sprint summary
                    +--------+--------+
                             |
                             v
                    +--------+--------+
                    |  Git Committer  | --> Conventional commit message
                    +--------+--------+
```

Each agent has isolated context — it only receives the inputs it needs, not the full conversation history.

## Setup

Requires [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI to be installed and authenticated.

```bash
npm install
```

## Usage

### Direct (you already know what you want)

```bash
node orchestrate.js "Build a REST API for a todo list with CRUD endpoints"
```

### With Spec Discovery (recommended for complex tasks)

```bash
# Interactive discovery, then auto-run the pipeline
node discover.js --run

# Or: discovery only (prints spec to stdout)
node discover.js
```

The discovery agent asks clarifying questions about your idea — users, data model, flows, scope — until it has enough to produce a structured specification. This eliminates guesswork downstream.

The orchestrator runs each agent in sequence, writes intermediate outputs to a timestamped workspace directory, and logs everything.

## Output

- `workspace/<run-id>/` — Agent outputs (PRD, tests, code, reviews, sprint summary, commit message)
- `logs/<run-id>.log` — Full pipeline log with timestamps

## Customizing Agent Prompts

Each agent's system prompt lives in `agents/prompts/<agent-name>.md`. Edit these files to change agent behavior:

| File | Agent | Purpose |
|------|-------|---------|
| `spec-discovery.md` | Spec Discovery | Interactive Q&A to produce a structured spec |
| `product-designer.md` | Product Designer | Generates the PRD |
| `test-writer.md` | Test Writer | Writes test specifications |
| `frontend-builder.md` | Frontend Builder | Writes frontend code |
| `backend-builder.md` | Backend Builder | Writes backend code |
| `code-reviewer.md` | Code Reviewer | Reviews code against PRD and tests |
| `pm.md` | PM | Writes sprint summary |
| `git-committer.md` | Git Committer | Generates commit message |

## Configuration

In `orchestrate.js`:
- `MODELS.default` — Model for complex agents (Product Designer, Builders, Reviewer). Default: `opus`
- `MODELS.fast` — Model for simpler agents (Test Writer, PM, Git Committer). Default: `sonnet`
- `MAX_REVIEW_ITERATIONS` — How many review/rebuild cycles before proceeding. Default: `3`

All agent calls go through the `claude` CLI (`claude --print`), so usage is billed through your Claude Code subscription — no separate API key needed.
