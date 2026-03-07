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

// ---------- Configuration ----------

const MODELS = {
  default: "opus",
  fast: "sonnet",
};

const MAX_REVIEW_ITERATIONS = 3;

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
        reject(new Error(`claude CLI exited with code ${code}:\n${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });

    // Pass everything via stdin to avoid shell escaping issues on Windows
    proc.stdin.write(`<instructions>\n${systemPrompt}\n</instructions>\n\n${userMessage}`);
    proc.stdin.end();
  });
}

async function runAgent({ name, systemPrompt, userMessage, model, logPath }) {
  const m = model ?? MODELS.default;
  await log(logPath, `AGENT: ${name} (${m}) — INPUT`, userMessage);

  const spinner = startSpinner(`Running ${name}`);
  let output;
  try {
    output = await runClaude({ systemPrompt, userMessage, model: m });
  } finally {
    stopSpinner(spinner);
  }

  await log(logPath, `AGENT: ${name} — OUTPUT`, output);
  return output;
}

// ---------- Pipeline steps ----------

async function stepProductDesigner({ task, workDir, logPath }) {
  const systemPrompt = await readPrompt("product-designer");
  const prd = await runAgent({
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
  const tests = await runAgent({
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
  const code = await runAgent({
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
  const code = await runAgent({
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
  const review = await runAgent({
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
  const summary = await runAgent({
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
  const commitMsg = await runAgent({
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
  console.error("Usage: node orchestrate.js \"your task description\"");
  process.exit(1);
}

orchestrate(task).catch((err) => {
  console.error("Orchestrator failed:", err);
  process.exit(1);
});
