/**
 * Agent Orchestrator
 *
 * Runs a sequential pipeline of specialized Claude agents, each with
 * isolated context, to take a task from idea to committed code.
 *
 * Usage:
 *   node orchestrate.js                    — interactive spec selector
 *   node orchestrate.js "task description" — direct orchestration
 *   node orchestrate.js --resume           — resume a previous run from a specific step
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

// ---------- Code extraction ----------

/**
 * Parse fenced code blocks from builder markdown output and write them as
 * real files under `projectDir`. Expects blocks with a file path comment on
 * the first line, e.g.:
 *   ```js
 *   // src/server.js
 *   ...code...
 *   ```
 * Returns the number of files written.
 */
async function extractCodeFiles(markdown, projectDir, logPath) {
  // Match fenced code blocks: ```lang\n...content...\n```
  const codeBlockRegex = /```[a-z]*\n([\s\S]*?)```/g;

  // Patterns to detect a file path on the first line of a code block
  const filePathPatterns = [
    /^\/\/\s*(.+\.\w+)\s*$/,        // // src/app.js
    /^#\s*(.+\.\w+)\s*$/,           // # src/app.py
    /^<!--\s*(.+\.\w+)\s*-->\s*$/,  // <!-- src/index.html -->
    /^\/\*\s*(.+\.\w+)\s*\*\/\s*$/, // /* src/styles.css */
    /^;\s*(.+\.\w+)\s*$/,           // ; config.ini
  ];

  let filesWritten = 0;
  let match;

  while ((match = codeBlockRegex.exec(markdown)) !== null) {
    const content = match[1];
    const firstLine = content.split("\n")[0].trim();

    let filePath = null;
    for (const pattern of filePathPatterns) {
      const m = firstLine.match(pattern);
      if (m) {
        filePath = m[1].trim();
        break;
      }
    }

    if (!filePath) continue;

    // Security: prevent path traversal
    const normalized = path.normalize(filePath);
    if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
      await log(logPath, "CODE EXTRACT — SKIPPED", `Suspicious path: ${filePath}`);
      continue;
    }

    const fullPath = path.join(projectDir, normalized);
    await ensureDir(path.dirname(fullPath));

    // Write the code without the file path comment line
    const codeLines = content.split("\n").slice(1);
    await fs.writeFile(fullPath, codeLines.join("\n"), "utf-8");
    filesWritten++;
  }

  return filesWritten;
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

async function stepTestWriter({ prd, workDir, projectDir, logPath }) {
  const systemPrompt = await readPrompt("test-writer");
  const tests = await runAgentWithRetry({
    name: "Test Writer",
    systemPrompt,
    userMessage: `Write executable test files based on this PRD:\n\n${prd}`,
    model: MODELS.fast,
    logPath,
  });
  await fs.writeFile(path.join(workDir, "tests.md"), tests, "utf-8");

  // Extract actual test files
  const count = await extractCodeFiles(tests, projectDir, logPath);
  if (count > 0) {
    await log(logPath, "CODE EXTRACT — TESTS", `Wrote ${count} test file(s) to ${projectDir}`);
    console.error(`  Extracted ${count} test file(s) to ${projectDir}`);
  }

  return tests;
}

async function stepFrontendBuilder({ prd, tests, workDir, projectDir, logPath }) {
  const systemPrompt = await readPrompt("frontend-builder");
  const code = await runAgentWithRetry({
    name: "Frontend Builder",
    systemPrompt,
    userMessage: `Build the frontend based on this PRD and these tests.\n\n## PRD\n${prd}\n\n## Tests\n${tests}`,
    logPath,
  });
  await fs.writeFile(path.join(workDir, "frontend.md"), code, "utf-8");

  // Extract actual source files
  const count = await extractCodeFiles(code, projectDir, logPath);
  if (count > 0) {
    await log(logPath, "CODE EXTRACT — FRONTEND", `Wrote ${count} file(s) to ${projectDir}`);
    console.error(`  Extracted ${count} frontend file(s) to ${projectDir}`);
  } else {
    console.error("  ⚠ No code blocks with file paths found in frontend output");
  }

  return code;
}

async function stepBackendBuilder({ prd, tests, workDir, projectDir, logPath }) {
  const systemPrompt = await readPrompt("backend-builder");
  const code = await runAgentWithRetry({
    name: "Backend Builder",
    systemPrompt,
    userMessage: `Build the backend based on this PRD and these tests.\n\n## PRD\n${prd}\n\n## Tests\n${tests}`,
    logPath,
  });
  await fs.writeFile(path.join(workDir, "backend.md"), code, "utf-8");

  // Extract actual source files
  const count = await extractCodeFiles(code, projectDir, logPath);
  if (count > 0) {
    await log(logPath, "CODE EXTRACT — BACKEND", `Wrote ${count} file(s) to ${projectDir}`);
    console.error(`  Extracted ${count} backend file(s) to ${projectDir}`);
  } else {
    console.error("  ⚠ No code blocks with file paths found in backend output");
  }

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

// ---------- Pipeline step definitions ----------

const STEPS = [
  { name: "prd",      label: "Product Designer", file: "prd.md" },
  { name: "tests",    label: "Test Writer",      file: "tests.md" },
  { name: "frontend", label: "Frontend Builder", file: "frontend.md" },
  { name: "backend",  label: "Backend Builder",  file: "backend.md" },
  { name: "review",   label: "Code Reviewer",    file: "review-1.md" },
  { name: "pm",       label: "PM Summary",       file: "sprint-summary.md" },
  { name: "commit",   label: "Git Committer",    file: "commit-message.md" },
];

// ---------- Main orchestration loop ----------

async function orchestrate(task, { resumeDir, startFrom } = {}) {
  const id = resumeDir ? path.basename(resumeDir) : runId();
  const workDir = resumeDir || path.join(import.meta.dirname, "workspace", id);
  const logPath = path.join(import.meta.dirname, "logs", `${id}.log`);

  const projectDir = path.join(workDir, "project");

  await ensureDir(workDir);
  await ensureDir(projectDir);
  await ensureDir(path.join(import.meta.dirname, "logs"));

  const startIndex = startFrom
    ? STEPS.findIndex((s) => s.name === startFrom)
    : 0;

  // Load existing artifacts from previous run
  async function loadArtifact(file) {
    try {
      return await fs.readFile(path.join(workDir, file), "utf-8");
    } catch {
      return null;
    }
  }

  if (resumeDir) {
    await log(logPath, "ORCHESTRATOR RESUMED", `Resuming from step: ${STEPS[startIndex].label}\nRun ID: ${id}`);
  } else {
    await log(logPath, "ORCHESTRATOR START", `Task: ${task}\nRun ID: ${id}`);
  }

  console.error(`\nWorkspace: ${workDir}`);
  console.error(`Log: ${logPath}\n`);

  // Step 1: PRD
  let prd;
  if (startIndex <= 0) {
    prd = await stepProductDesigner({ task, workDir, logPath });
  } else {
    prd = await loadArtifact("prd.md");
    if (!prd) throw new Error("Cannot resume: prd.md not found in workspace");
    console.error("  Loaded existing prd.md");
  }

  // Step 2: Tests
  let tests;
  if (startIndex <= 1) {
    if (startIndex < 1) {
      // Already ran PRD above, continue normally
    }
    tests = await stepTestWriter({ prd, workDir, projectDir, logPath });
  } else {
    tests = await loadArtifact("tests.md");
    if (!tests) throw new Error("Cannot resume: tests.md not found in workspace");
    console.error("  Loaded existing tests.md");
  }

  // Step 3: Build
  let frontend, backend;
  if (startIndex <= 2) {
    frontend = await stepFrontendBuilder({ prd, tests, workDir, projectDir, logPath });
  } else {
    frontend = await loadArtifact("frontend.md");
    if (!frontend) throw new Error("Cannot resume: frontend.md not found in workspace");
    console.error("  Loaded existing frontend.md");
  }

  if (startIndex <= 3) {
    if (startIndex > 2) {
      // Resuming from backend specifically — frontend was loaded above
    }
    backend = await stepBackendBuilder({ prd, tests, workDir, projectDir, logPath });
  } else {
    backend = await loadArtifact("backend.md");
    if (!backend) throw new Error("Cannot resume: backend.md not found in workspace");
    console.error("  Loaded existing backend.md");
  }

  // Step 4: Review loop
  let approved = false;
  let currentFrontend = frontend;
  let currentBackend = backend;

  if (startIndex <= 4) {
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
          projectDir,
          logPath,
        });
        currentBackend = await stepBackendBuilder({
          prd,
          tests: `${tests}\n\n## Reviewer Feedback\n${review}`,
          workDir,
          projectDir,
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
  }

  // Step 5: Install dependencies and validate
  checkShutdown();
  const packageJsonPath = path.join(projectDir, "package.json");
  try {
    await fs.access(packageJsonPath);
    console.error("\n  Installing dependencies...");
    const installResult = await new Promise((resolve) => {
      const proc = spawn("npm", ["install"], {
        cwd: projectDir,
        shell: true,
        windowsHide: true,
      });
      let out = "";
      let err = "";
      proc.stdout.on("data", (d) => { out += d; });
      proc.stderr.on("data", (d) => { err += d; });
      proc.on("close", (code) => resolve({ code, out, err }));
    });

    if (installResult.code === 0) {
      await log(logPath, "NPM INSTALL", "Dependencies installed successfully.");
      console.error("  Dependencies installed successfully.");
    } else {
      await log(logPath, "NPM INSTALL — FAILED", installResult.err || installResult.out);
      console.error(`  ⚠ npm install failed (exit ${installResult.code}). Check the log for details.`);
    }
  } catch {
    await log(logPath, "NPM INSTALL — SKIPPED", "No package.json found in project directory.");
    console.error("  ⚠ No package.json found — the backend builder may not have produced one.");
  }

  // Step 6: PM summary
  if (startIndex <= 5) {
    await stepPM({ prd, workDir, logPath });
  }

  // Step 7: Commit message
  if (startIndex <= 6) {
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
  }

  // Summary
  let fileCount = 0;
  try {
    const listFiles = async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      let count = 0;
      for (const e of entries) {
        if (e.name === "node_modules") continue;
        if (e.isDirectory()) count += await listFiles(path.join(dir, e.name));
        else count++;
      }
      return count;
    };
    fileCount = await listFiles(projectDir);
  } catch {}

  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Project ready! (${fileCount} files)`);
  console.log(`${"=".repeat(50)}`);
  console.log(`\n  Project:   ${projectDir}`);
  console.log(`  Workspace: ${workDir}`);
  console.log(`  Log:       ${logPath}`);
  console.log(`\n  To run:`);
  console.log(`    cd ${projectDir}`);
  console.log(`    npm start`);
  console.log(`\n  To test:`);
  console.log(`    cd ${projectDir}`);
  console.log(`    npm test`);
}

// ---------- Interactive spec selector ----------

async function findSpecs() {
  const workspaceDir = path.join(import.meta.dirname, "workspace");
  try {
    const entries = await fs.readdir(workspaceDir);
    const specs = [];
    for (const entry of entries.sort().reverse()) {
      const specPath = path.join(workspaceDir, entry, "spec.md");
      try {
        const content = await fs.readFile(specPath, "utf-8");
        const firstLine = content.split("\n").find((l) => l.trim()) || "(empty spec)";
        specs.push({ id: entry, path: specPath, preview: firstLine.slice(0, 80), content });
      } catch {
        // no spec.md in this directory, skip
      }
    }
    return specs;
  } catch {
    return [];
  }
}

async function interactiveSelect() {
  const specs = await findSpecs();
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const question = (q) => new Promise((resolve) => rl.question(q, resolve));

  console.error("\n╔══════════════════════════════════════╗");
  console.error("║        Agent Orchestrator            ║");
  console.error("╚══════════════════════════════════════╝\n");

  if (specs.length > 0) {
    console.error("Available specs:\n");
    for (let i = 0; i < specs.length; i++) {
      console.error(`  ${i + 1}) [${specs[i].id}]`);
      console.error(`     ${specs[i].preview}`);
    }
    console.error(`\n  0) Enter a new task description\n`);

    const answer = await question("Select a spec (number): ");
    const choice = parseInt(answer.trim(), 10);

    if (choice >= 1 && choice <= specs.length) {
      rl.close();
      return specs[choice - 1].content;
    }

    if (choice !== 0 && answer.trim() !== "") {
      console.error("Invalid selection, entering new task mode.\n");
    }
  } else {
    console.error("No saved specs found in workspace/.\n");
  }

  const task = await question("Enter task description: ");
  rl.close();

  if (!task.trim()) {
    console.error("No task provided. Exiting.");
    process.exit(1);
  }
  return task.trim();
}

// ---------- Resume picker ----------

async function findRuns() {
  const workspaceDir = path.join(import.meta.dirname, "workspace");
  try {
    const entries = await fs.readdir(workspaceDir);
    const runs = [];
    for (const entry of entries.sort().reverse()) {
      const dir = path.join(workspaceDir, entry);
      const artifacts = [];
      for (const step of STEPS) {
        try {
          await fs.access(path.join(dir, step.file));
          artifacts.push(step.name);
        } catch {
          // artifact doesn't exist
        }
      }
      // Also check for spec.md (from discover.js)
      let hasSpec = false;
      try {
        await fs.access(path.join(dir, "spec.md"));
        hasSpec = true;
      } catch {}
      if (artifacts.length > 0 || hasSpec) {
        runs.push({ id: entry, dir, artifacts, hasSpec });
      }
    }
    return runs;
  } catch {
    return [];
  }
}

function detectNextStep(artifacts) {
  for (const step of STEPS) {
    if (!artifacts.includes(step.name)) return step;
  }
  return null; // all steps complete
}

async function interactiveResume() {
  const runs = await findRuns();
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const question = (q) => new Promise((resolve) => rl.question(q, resolve));

  console.error("\n╔══════════════════════════════════════╗");
  console.error("║     Resume Previous Run              ║");
  console.error("╚══════════════════════════════════════╝\n");

  if (runs.length === 0) {
    console.error("No previous runs found.");
    rl.close();
    process.exit(1);
  }

  console.error("Previous runs:\n");
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const completed = run.artifacts.map((a) => {
      const step = STEPS.find((s) => s.name === a);
      return step ? step.label : a;
    });
    const next = detectNextStep(run.artifacts);
    const status = next ? `next: ${next.label}` : "all steps complete";
    console.error(`  ${i + 1}) [${run.id}]`);
    console.error(`     Completed: ${completed.join(", ") || "none"}`);
    console.error(`     Status: ${status}\n`);
  }

  const runAnswer = await question("Select a run (number): ");
  const runChoice = parseInt(runAnswer.trim(), 10);

  if (runChoice < 1 || runChoice > runs.length) {
    console.error("Invalid selection. Exiting.");
    rl.close();
    process.exit(1);
  }

  const selectedRun = runs[runChoice - 1];
  const nextStep = detectNextStep(selectedRun.artifacts);

  console.error("\nResume from which step?\n");
  for (let i = 0; i < STEPS.length; i++) {
    const step = STEPS[i];
    const has = selectedRun.artifacts.includes(step.name);
    const marker = step === nextStep ? " <-- suggested" : "";
    console.error(`  ${i + 1}) ${step.label} ${has ? "(done)" : "(pending)"}${marker}`);
  }

  const defaultStep = nextStep ? STEPS.indexOf(nextStep) + 1 : 1;
  const stepAnswer = await question(`\nStart from step (default ${defaultStep}): `);
  const stepChoice = parseInt(stepAnswer.trim(), 10) || defaultStep;

  rl.close();

  if (stepChoice < 1 || stepChoice > STEPS.length) {
    console.error("Invalid step. Exiting.");
    process.exit(1);
  }

  const startFrom = STEPS[stepChoice - 1].name;

  // Load task from spec.md or prd.md
  let task;
  try {
    task = await fs.readFile(path.join(selectedRun.dir, "spec.md"), "utf-8");
  } catch {
    try {
      task = await fs.readFile(path.join(selectedRun.dir, "prd.md"), "utf-8");
    } catch {
      console.error("Warning: No spec.md or prd.md found — task context may be missing.");
      task = "(resumed run — original task not available)";
    }
  }

  return { task, resumeDir: selectedRun.dir, startFrom };
}

// ---------- Entry point ----------

const isResume = process.argv.includes("--resume");
const cliTask = isResume ? null : process.argv.slice(2).join(" ");

if (isResume) {
  interactiveResume().then(({ task, resumeDir, startFrom }) =>
    orchestrate(task, { resumeDir, startFrom })
  ).catch((err) => {
    if (err.message === "SHUTDOWN") {
      console.error("\nOrchestrator stopped by user. Partial results may be in workspace/.");
      process.exit(0);
    }
    console.error(`\nOrchestrator failed: ${err.message}`);
    process.exit(1);
  });
} else {
  const task = cliTask || await interactiveSelect();

  orchestrate(task).catch((err) => {
    if (err.message === "SHUTDOWN") {
      console.error("\nOrchestrator stopped by user. Partial results may be in workspace/.");
      process.exit(0);
    }
    console.error(`\nOrchestrator failed: ${err.message}`);
    console.error("Partial results may be saved in workspace/. Check the log for details.");
    process.exit(1);
  });
}
