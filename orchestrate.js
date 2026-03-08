/**
 * Agent Orchestrator
 *
 * Runs a sequential pipeline of specialized Claude agents, each with
 * isolated context, to take a task from idea to committed code.
 *
 * Usage: node orchestrate.js "your task description"
 */

import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import readline from "readline";

// ---------- Configuration ----------

const MODELS = {
  default: "opus",
  fast: "sonnet",
};

const MAX_REVIEW_ITERATIONS = 3;
const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 10_000; // 10 seconds base, doubles each retry

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

function runId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function readPrompt(name) {
  const p = path.join(import.meta.dirname, "agents", "prompts", `${name}.md`);
  return fs.readFile(p, "utf-8");
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function log(logPath, label, content) {
  const entry = `\n${"=".repeat(60)}\n[${new Date().toISOString()}] ${label}\n${"=".repeat(60)}\n${content}\n`;
  process.stdout.write(entry);
  return fs.appendFile(logPath, entry, "utf-8");
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
    // Allow Ctrl+C to interrupt sleep
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

// ---------- Core agent call ----------

function runClaude({ systemPrompt, userMessage, model }) {
  return new Promise((resolve, reject) => {
    const args = [
      "--print",
      "--model", model,
      "--disallowedTools", "Bash,Edit,Write,NotebookEdit",
      "--no-session-persistence",
    ];

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

    proc.stdin.write(`<instructions>\n${systemPrompt}\n</instructions>\n\n${userMessage}`);
    proc.stdin.end();
  });
}

async function runAgentWithRetry({ name, systemPrompt, userMessage, model, logPath }) {
  const m = model ?? MODELS.default;
  await log(logPath, `AGENT: ${name} (${m}) — INPUT`, userMessage);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    checkShutdown();

    const spinner = startSpinner(
      attempt === 1 ? `Running ${name}` : `Running ${name} (retry ${attempt}/${MAX_RETRIES})`
    );

    try {
      const output = await runClaude({ systemPrompt, userMessage, model: m });
      stopSpinner(spinner);
      await log(logPath, `AGENT: ${name} — OUTPUT`, output);
      return output;
    } catch (err) {
      stopSpinner(spinner);

      if (err.message === "SHUTDOWN") throw err;

      const isLastAttempt = attempt === MAX_RETRIES;

      if (err.isRateLimit) {
        const waitSec = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), 300_000) / 1000;
        await log(logPath, `AGENT: ${name} — RATE LIMITED`, `Attempt ${attempt}. Waiting ${waitSec}s...`);
        console.error(`\n⏳ Rate limited. Waiting ${waitSec}s before retry... (Ctrl+C to cancel)`);

        if (isLastAttempt) {
          // On last attempt for rate limit, ask user
          const shouldContinue = await askUserToContinue(
            `Rate limit hit after ${MAX_RETRIES} retries. Keep waiting? (y/n): `
          );
          if (shouldContinue) {
            attempt--; // retry same attempt number
            await sleep(waitSec * 1000);
            continue;
          }
          throw new Error(`Rate limited after ${MAX_RETRIES} attempts on agent "${name}".`);
        }

        await sleep(waitSec * 1000);
        continue;
      }

      if (err.isTransient && !isLastAttempt) {
        const waitSec = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), 120_000) / 1000;
        await log(logPath, `AGENT: ${name} — TRANSIENT ERROR`, `${err.message}\nRetrying in ${waitSec}s...`);
        console.error(`\n⚠ Transient error on ${name}: ${err.message.slice(0, 200)}`);
        console.error(`  Retrying in ${waitSec}s... (attempt ${attempt}/${MAX_RETRIES})`);
        await sleep(waitSec * 1000);
        continue;
      }

      // Non-transient or last attempt
      await log(logPath, `AGENT: ${name} — FAILED`, err.message);
      throw err;
    }
  }
}

function askUserToContinue(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith("y"));
    });
  });
}

// ---------- Pipeline steps ----------

async function stepProductDesigner({ task, workDir, logPath }) {
  const systemPrompt = await readPrompt("product-designer");
  const prd = await runAgentWithRetry({
    name: "Product Designer",
    systemPrompt,
    userMessage: `Create a Product Requirements Document for this task:\n\n${task}`,
    logPath,
  });
  await fs.writeFile(path.join(workDir, "prd.md"), prd, "utf-8");
  return prd;
}

async function stepTestWriter({ prd, workDir, logPath }) {
  const systemPrompt = await readPrompt("test-writer");
  const tests = await runAgentWithRetry({
    name: "Test Writer",
    systemPrompt,
    userMessage: `Write tests based on this PRD:\n\n${prd}`,
    model: MODELS.fast,
    logPath,
  });
  await fs.writeFile(path.join(workDir, "tests.md"), tests, "utf-8");
  return tests;
}

async function stepFrontendBuilder({ prd, tests, workDir, logPath }) {
  const systemPrompt = await readPrompt("frontend-builder");
  const code = await runAgentWithRetry({
    name: "Frontend Builder",
    systemPrompt,
    userMessage: `Build the frontend based on this PRD and these tests.\n\n## PRD\n${prd}\n\n## Tests\n${tests}`,
    logPath,
  });
  await fs.writeFile(path.join(workDir, "frontend.md"), code, "utf-8");
  return code;
}

async function stepBackendBuilder({ prd, tests, workDir, logPath }) {
  const systemPrompt = await readPrompt("backend-builder");
  const code = await runAgentWithRetry({
    name: "Backend Builder",
    systemPrompt,
    userMessage: `Build the backend based on this PRD and these tests.\n\n## PRD\n${prd}\n\n## Tests\n${tests}`,
    logPath,
  });
  await fs.writeFile(path.join(workDir, "backend.md"), code, "utf-8");
  return code;
}

async function stepCodeReviewer({
  prd,
  tests,
  frontend,
  backend,
  iteration,
  workDir,
  logPath,
}) {
  const systemPrompt = await readPrompt("code-reviewer");
  const review = await runAgentWithRetry({
    name: `Code Reviewer (iteration ${iteration})`,
    systemPrompt,
    userMessage: `Review this code. Reply with SHIP IT if it passes, or detailed feedback if it does not.\n\n## PRD\n${prd}\n\n## Tests\n${tests}\n\n## Frontend Code\n${frontend}\n\n## Backend Code\n${backend}`,
    logPath,
  });
  await fs.writeFile(
    path.join(workDir, `review-${iteration}.md`),
    review,
    "utf-8"
  );
  return review;
}

async function stepPM({ prd, workDir, logPath }) {
  const systemPrompt = await readPrompt("pm");
  const summary = await runAgentWithRetry({
    name: "PM",
    systemPrompt,
    userMessage: `Document the completed sprint based on this PRD:\n\n${prd}`,
    model: MODELS.fast,
    logPath,
  });
  await fs.writeFile(path.join(workDir, "sprint-summary.md"), summary, "utf-8");
  return summary;
}

async function stepGitCommitter({ prd, frontend, backend, workDir, logPath }) {
  const systemPrompt = await readPrompt("git-committer");
  const commitMsg = await runAgentWithRetry({
    name: "Git Committer",
    systemPrompt,
    userMessage: `Generate a conventional commit message for the following work.\n\n## PRD\n${prd}\n\n## Frontend Changes\n${frontend}\n\n## Backend Changes\n${backend}`,
    model: MODELS.fast,
    logPath,
  });
  await fs.writeFile(path.join(workDir, "commit-message.md"), commitMsg, "utf-8");
  return commitMsg;
}

// ---------- Main orchestration loop ----------

async function orchestrate(task) {
  const id = runId();
  const workDir = path.join(import.meta.dirname, "workspace", id);
  const logPath = path.join(import.meta.dirname, "logs", `${id}.log`);

  await ensureDir(workDir);
  await ensureDir(path.join(import.meta.dirname, "logs"));

  await log(logPath, "ORCHESTRATOR START", `Task: ${task}\nRun ID: ${id}`);

  console.error(`\nWorkspace: ${workDir}`);
  console.error(`Log: ${logPath}\n`);

  // Step 1: PRD
  const prd = await stepProductDesigner({ task, workDir, logPath });

  // Step 2: Tests
  const tests = await stepTestWriter({ prd, workDir, logPath });

  // Step 3: Build (frontend + backend in sequence to keep logs readable)
  const frontend = await stepFrontendBuilder({ prd, tests, workDir, logPath });
  const backend = await stepBackendBuilder({ prd, tests, workDir, logPath });

  // Step 4: Review loop
  let approved = false;
  let currentFrontend = frontend;
  let currentBackend = backend;

  for (let i = 1; i <= MAX_REVIEW_ITERATIONS; i++) {
    checkShutdown();

    const review = await stepCodeReviewer({
      prd,
      tests,
      frontend: currentFrontend,
      backend: currentBackend,
      iteration: i,
      workDir,
      logPath,
    });

    if (review.includes("SHIP IT")) {
      await log(logPath, "REVIEW APPROVED", `Approved on iteration ${i}`);
      approved = true;
      break;
    }

    if (i < MAX_REVIEW_ITERATIONS) {
      await log(
        logPath,
        "REVIEW REJECTED",
        `Iteration ${i} — rebuilding with feedback`
      );
      currentFrontend = await stepFrontendBuilder({
        prd,
        tests: `${tests}\n\n## Reviewer Feedback\n${review}`,
        workDir,
        logPath,
      });
      currentBackend = await stepBackendBuilder({
        prd,
        tests: `${tests}\n\n## Reviewer Feedback\n${review}`,
        workDir,
        logPath,
      });
    } else {
      await log(
        logPath,
        "REVIEW MAX ITERATIONS REACHED",
        "Proceeding despite review failures — manual intervention needed."
      );
    }
  }

  // Step 5: PM summary
  await stepPM({ prd, workDir, logPath });

  // Step 6: Commit message
  const commitMsg = await stepGitCommitter({
    prd,
    frontend: currentFrontend,
    backend: currentBackend,
    workDir,
    logPath,
  });

  await log(
    logPath,
    "ORCHESTRATOR COMPLETE",
    `Run ID: ${id}\nWorkspace: ${workDir}\nApproved: ${approved}\n\nCommit message:\n${commitMsg}`
  );

  console.log(`\nDone. Outputs written to: ${workDir}`);
  console.log(`Full log: ${logPath}`);
}

// ---------- Entry point ----------

const task = process.argv.slice(2).join(" ");
if (!task) {
  console.error('Usage: node orchestrate.js "your task description"');
  process.exit(1);
}

orchestrate(task).catch((err) => {
  if (err.message === "SHUTDOWN") {
    console.error("\nOrchestrator stopped by user. Partial results may be in workspace/.");
    process.exit(0);
  }
  console.error(`\nOrchestrator failed: ${err.message}`);
  console.error("Partial results may be saved in workspace/. Check the log for details.");
  process.exit(1);
});
