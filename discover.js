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
        // Empty line after content = submit
        rl.removeListener("line", onLine);
        resolve(lines.join("\n"));
      } else {
        lines.push(line);
      }
    };
    rl.on("line", onLine);
  });
}

function callClaude(args, stdinData) {
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
        reject(new Error(`claude CLI exited with code ${code}:\n${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });

    proc.stdin.write(stdinData);
    proc.stdin.end();
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
  process.stderr.write("\r\x1b[K"); // clear the line
}

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
      const { spawn: spawnSync } = await import("child_process");
      const proc = spawnSync("node", [
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
    console.error("Discovery failed:", err.message);
    process.exit(1);
  });
