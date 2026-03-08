/**
 * Spec Discovery
 *
 * Interactive conversation with a discovery agent that asks clarifying
 * questions until it has enough information to produce a structured
 * specification. The spec can then be piped into the orchestrator.
 *
 * Usage:
 *   node discover.js                    — interactive discovery, prints spec to stdout
 *   node discover.js --run              — discovery then auto-run orchestrator
 */

import { spawn } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import readline from "readline";

const MODEL = "sonnet";
const SPEC_MARKER = "SPEC COMPLETE";
const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 10_000;

// ---------- Graceful shutdown ----------

let shuttingDown = false;

process.on("SIGINT", () => {
  if (shuttingDown) {
    console.error("\nForce quit.");
    process.exit(1);
  }
  shuttingDown = true;
  console.error("\nShutting down gracefully... (Ctrl+C again to force quit)");
});

function checkShutdown() {
  if (shuttingDown) {
    throw new Error("SHUTDOWN");
  }
}

// ---------- Utilities ----------

async function readPrompt(name) {
  const p = path.join(import.meta.dirname, "agents", "prompts", `${name}.md`);
  return fs.readFile(p, "utf-8");
}

function createRL() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
}

async function ask(rl, prompt) {
  process.stderr.write(prompt);
  const lines = [];
  return new Promise((resolve) => {
    const onLine = (line) => {
      if (line === "" && lines.length > 0) {
        rl.removeListener("line", onLine);
        resolve(lines.join("\n"));
      } else {
        lines.push(line);
      }
    };
    rl.on("line", onLine);
  });
}

function startSpinner(message) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  return setInterval(() => {
    process.stderr.write(`\r${frames[i++ % frames.length]} ${message}...`);
  }, 100);
}

function stopSpinner(interval) {
  clearInterval(interval);
  process.stderr.write("\r\x1b[K");
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const check = setInterval(() => {
      if (shuttingDown) {
        clearTimeout(timer);
        clearInterval(check);
        resolve();
      }
    }, 500);
  });
}

// ---------- Error detection ----------

const RATE_LIMIT_PATTERNS = [
  /out of.*usage/i,
  /rate.?limit/i,
  /usage.?limit/i,
  /too many requests/i,
  /overloaded/i,
  /capacity/i,
  /throttl/i,
  /429/,
  /try again/i,
];

function isRateLimitError(errorText) {
  return RATE_LIMIT_PATTERNS.some((p) => p.test(errorText));
}

function isTransientError(errorText) {
  return (
    isRateLimitError(errorText) ||
    /timeout/i.test(errorText) ||
    /ECONNRESET/i.test(errorText) ||
    /ECONNREFUSED/i.test(errorText) ||
    /ETIMEDOUT/i.test(errorText) ||
    /network/i.test(errorText) ||
    /5\d\d/.test(errorText) ||
    /internal.*error/i.test(errorText) ||
    /service.*unavailable/i.test(errorText)
  );
}

// ---------- Claude CLI call ----------

function callClaudeOnce(args, stdinData) {
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", args, { shell: true, windowsHide: true });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });

    proc.on("error", (err) => {
      reject(new Error(`Failed to start claude CLI: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        const errText = stderr || stdout || `exit code ${code}`;
        const err = new Error(errText);
        err.isRateLimit = isRateLimitError(errText);
        err.isTransient = isTransientError(errText);
        reject(err);
      } else {
        resolve(stdout.trim());
      }
    });

    proc.stdin.write(stdinData);
    proc.stdin.end();
  });
}

async function callClaude(args, stdinData) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    checkShutdown();

    try {
      return await callClaudeOnce(args, stdinData);
    } catch (err) {
      if (err.message === "SHUTDOWN") throw err;

      const isLastAttempt = attempt === MAX_RETRIES;

      if (err.isRateLimit) {
        const waitSec = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), 300_000) / 1000;
        console.error(`\n⏳ Rate limited. Waiting ${waitSec}s before retry... (Ctrl+C to cancel)`);

        if (isLastAttempt) {
          console.error(`\n⏳ Still rate limited after ${MAX_RETRIES} retries. Waiting another ${waitSec}s...`);
          console.error("   Press Ctrl+C to stop waiting.");
          attempt--; // keep retrying rate limits indefinitely
        }

        await sleep(waitSec * 1000);
        continue;
      }

      if (err.isTransient && !isLastAttempt) {
        const waitSec = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), 120_000) / 1000;
        console.error(`\n⚠ Transient error: ${err.message.slice(0, 200)}`);
        console.error(`  Retrying in ${waitSec}s... (attempt ${attempt}/${MAX_RETRIES})`);
        await sleep(waitSec * 1000);
        continue;
      }

      // Non-transient or final attempt — don't crash, let caller decide
      throw err;
    }
  }
}

// ---------- Discovery conversation ----------

async function discover() {
  const systemPrompt = await readPrompt("spec-discovery");
  const sessionId = randomUUID();
  const rl = createRL();
  let isFirstMessage = true;

  console.error("=== Spec Discovery ===");
  console.error("Describe your idea and the agent will ask clarifying questions.");
  console.error("Type your answer (multiple lines OK), then press Enter twice to submit.");
  console.error('Type "done" to force completion, or Ctrl+C to abort.\n');

  // Get initial idea
  const idea = await ask(rl, "What do you want to build?\n> ");
  if (!idea.trim()) {
    console.error("No input provided. Exiting.");
    rl.close();
    process.exit(1);
  }

  let userMessage = idea;

  // Conversation loop
  while (true) {
    checkShutdown();

    let args;
    let stdinData;
    if (isFirstMessage) {
      args = [
        "--print",
        "--model", MODEL,
        "--session-id", sessionId,
        "--disallowedTools", "Bash,Edit,Write,NotebookEdit",
      ];
      stdinData = `<instructions>\n${systemPrompt}\n</instructions>\n\n${userMessage}`;
      isFirstMessage = false;
    } else {
      args = [
        "--print",
        "--resume", sessionId,
        "--disallowedTools", "Bash,Edit,Write,NotebookEdit",
      ];
      stdinData = userMessage;
    }

    const spinner = startSpinner("Thinking");
    let output;
    try {
      output = await callClaude(args, stdinData);
    } catch (err) {
      stopSpinner(spinner);
      if (err.message === "SHUTDOWN") throw err;

      // Non-fatal: show error and let user try again
      console.error(`\n⚠ Error from Claude: ${err.message.slice(0, 300)}`);
      console.error("  Type your message again to retry, or Ctrl+C to quit.\n");

      // Reset firstMessage flag if the first call failed
      if (!output && stdinData.includes("<instructions>")) {
        isFirstMessage = true;
      }

      const answer = await ask(rl, "> ");
      if (answer.toLowerCase().trim() === "done") {
        userMessage =
          "That's all the information I have. Please finalize the specification with what you know, making reasonable assumptions for anything unclear.";
      } else {
        userMessage = answer;
      }
      continue;
    } finally {
      stopSpinner(spinner);
    }

    // Check if spec is complete
    if (output.includes(SPEC_MARKER)) {
      const specStart = output.indexOf(SPEC_MARKER);
      const spec = output.slice(specStart + SPEC_MARKER.length).trim();

      console.error("\n=== Specification Complete ===\n");
      rl.close();
      return spec;
    }

    // Show agent's questions
    console.error(`\n${output}\n`);

    // Get user's answer
    const answer = await ask(rl, "> ");

    if (answer.toLowerCase().trim() === "done") {
      userMessage =
        "That's all the information I have. Please finalize the specification with what you know, making reasonable assumptions for anything unclear.";
    } else {
      userMessage = answer;
    }
  }
}

// ---------- Entry point ----------

const autoRun = process.argv.includes("--run");

discover()
  .then(async (spec) => {
    // Save spec to workspace
    const id = new Date().toISOString().replace(/[:.]/g, "-");
    const specDir = path.join(import.meta.dirname, "workspace", id);
    await fs.mkdir(specDir, { recursive: true });
    const specPath = path.join(specDir, "spec.md");
    await fs.writeFile(specPath, spec, "utf-8");
    console.error(`Spec saved to: ${specPath}`);

    // Also print to stdout (for piping)
    console.log(spec);

    if (autoRun) {
      console.error("\n=== Starting Orchestrator ===\n");
      const proc = spawn("node", [
        path.join(import.meta.dirname, "orchestrate.js"),
        spec,
      ], { cwd: import.meta.dirname, stdio: "inherit", shell: true });
      proc.on("close", (code) => process.exit(code ?? 0));
    } else {
      console.error(
        "Spec printed to stdout. To orchestrate, run:\n" +
          "  node discover.js --run"
      );
    }
  })
  .catch((err) => {
    if (err.message === "SHUTDOWN") {
      console.error("\nDiscovery stopped by user.");
      process.exit(0);
    }
    console.error(`\nDiscovery failed: ${err.message}`);
    process.exit(1);
  });
