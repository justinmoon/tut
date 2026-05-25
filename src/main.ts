#!/usr/bin/env bun

import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createCliRenderer, type CliRenderer, type KeyEvent } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { createElement, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

type Provider = "claude" | "codex" | "none";
type ReviewStatus = "generating" | "ready" | "failed";

interface TutorialDoc {
  executive_summary: string;
  media_links: string[];
  steps: TutorialStep[];
}

interface TutorialStep {
  title: string;
  intent: string;
  affected_files: string[];
  evidence_snippets: string[];
  body_markdown: string;
}

interface AgentAnnotation {
  oldRange?: [number, number];
  newRange?: [number, number];
  summary: string;
  rationale?: string;
  tags?: string[];
  source?: string;
  title?: string;
  author?: string;
}

interface AgentContext {
  version: number;
  summary?: string;
  files: Array<{
    path: string;
    summary?: string;
    annotations: AgentAnnotation[];
  }>;
}

interface ParsedHunkRange {
  oldRange?: [number, number];
  newRange?: [number, number];
}

interface GenerateOptions {
  cwd: string;
  range?: string;
  base?: string;
  about?: string;
  includeUncommitted: boolean;
  out?: string;
  sidecarOut?: string;
  tutorialJson?: string;
  provider: Provider;
  model?: string;
  maxDiffChars: number;
  sourceSession?: AgentSessionRef;
  forkSession?: AgentSessionRef;
}

interface ReviewManifest {
  id: string;
  createdAt: string;
  repoRoot: string;
  repoName: string;
  range: string;
  title: string;
  summary: string;
  markdownPath: string;
  sidecarPath: string;
  provider: Provider;
  status?: ReviewStatus;
  commitSha?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  logPath?: string;
  workerPid?: number;
  maxDiffChars?: number;
  doneAt?: string;
  model?: string;
  sessionId?: string;
  sourceSession?: string;
  forkSession?: string;
  archived?: boolean;
}

interface AgentSessionRef {
  provider: "claude" | "codex";
  id: string;
}

interface PromptInput {
  request: {
    focus?: string;
    source_session?: string;
    fork_session?: string;
  };
  repo: {
    name: string;
    root: string;
    head_sha?: string;
    base_ref?: string;
    range?: string;
  };
  files: string[];
  unified_diff: string;
}

interface GenerationOutput {
  tutorial: TutorialDoc;
  sessionId?: string;
}

interface ReviewSeed {
  id: string;
  createdAt: string;
  markdownPath: string;
  sidecarPath: string;
  commitSha?: string;
  startedAt?: string;
  logPath?: string;
  workerPid?: number;
}

/** Print top-level usage for the standalone companion CLI. */
function usage() {
  return [
    "Usage:",
    "  tut [range] [options]",
    "  tut generate [range] [options]",
    "  tut inbox",
    "  tut list [--all]",
    "  tut open <id>",
    "  tut chat [id]",
    "  tut enqueue [ref] [options]",
    "  tut retry <id>",
    "  tut jobs",
    "  tut done <id-or-commit>",
    "  tut undone <id-or-commit>",
    "  tut archive <id>",
    "  tut fork <claude|codex>:<session-id> [prompt]",
    "",
    "Generate a markdown tutorial and Hunk agent-context sidecar from a git diff.",
    "",
    "Options:",
    "  --about <text>              Focus the tutorial on a concern or feature",
    "  --base <ref>                Default range base when no range is passed",
    "  --include-uncommitted       Append staged and unstaged changes to the input",
    "  --out <path>                Markdown output path (default: durable inbox artifact)",
    "  --sidecar-out <path>        Hunk sidecar output path (default: durable inbox artifact)",
    "  --tutorial-json <path>      Use an existing tutorial JSON response instead of calling a provider",
    "  --provider <name>           claude, codex, or none (default: claude if present, else codex, else none)",
    "  --model <name>              Provider model name",
    "  --max-diff-chars <n>        Diff prompt budget (default: 60000)",
    "  --source-session <ref>      Originating agent session, e.g. codex:<uuid> or claude:<uuid>",
    "  --fork-session <ref>        Forked session to resume for generation, e.g. codex:<uuid>",
    "  --cwd <path>                Git repo path (default: current directory)",
    "",
    "Examples:",
    "  tut HEAD~5..HEAD --about \"session broker changes\"",
    "  tut --base origin/main --include-uncommitted",
    "  tut enqueue HEAD --cwd /path/to/repo",
    "  tut inbox",
    "  tut done HEAD",
    "  tut chat",
    "  hunk diff HEAD~5..HEAD --agent-context tutorial.agent.json --agent-notes",
    "  tut fork codex:00000000-0000-0000-0000-000000000000 \"explain the risky part\"",
    "",
  ].join("\n");
}

/** Parse CLI arguments without taking a dependency on a command framework. */
function parseArgs(argv: string[]) {
  const [maybeCommand, ...rest] = argv;
  if (maybeCommand === "-h" || maybeCommand === "--help") {
    return { kind: "help" as const };
  }
  if (maybeCommand === "fork") {
    return parseForkArgs(rest);
  }
  if (maybeCommand === "inbox") {
    return { kind: "inbox" as const, includeDone: parseAllFlag(rest, "inbox") };
  }
  if (maybeCommand === "list") {
    return { kind: "list" as const, includeDone: parseAllFlag(rest, "list") };
  }
  if (maybeCommand === "open") {
    return { kind: "open" as const, id: parseRequiredId(rest, "open") };
  }
  if (maybeCommand === "chat") {
    return { kind: "chat" as const, id: rest[0]?.trim() || undefined };
  }
  if (maybeCommand === "enqueue") {
    return parseEnqueueArgs(rest);
  }
  if (maybeCommand === "retry") {
    return { kind: "retry" as const, id: parseRequiredId(rest, "retry") };
  }
  if (maybeCommand === "jobs") {
    return { kind: "jobs" as const };
  }
  if (maybeCommand === "done") {
    return { kind: "done" as const, id: parseRequiredId(rest, "done") };
  }
  if (maybeCommand === "undone") {
    return { kind: "undone" as const, id: parseRequiredId(rest, "undone") };
  }
  if (maybeCommand === "worker") {
    return { kind: "worker" as const, id: parseRequiredId(rest, "worker") };
  }
  if (maybeCommand === "archive") {
    return { kind: "archive" as const, id: parseRequiredId(rest, "archive") };
  }
  if (maybeCommand === "generate") {
    return parseGenerateArgs(rest);
  }
  return parseGenerateArgs(argv);
}

/** Parse the shared `--all` flag accepted by list-like commands. */
function parseAllFlag(argv: string[], command: string) {
  let includeDone = false;
  for (const arg of argv) {
    if (arg === "--all") {
      includeDone = true;
    } else {
      throw new Error(`Unknown option for ${command}: ${arg}`);
    }
  }
  return includeDone;
}

/** Parse a background enqueue request from a git hook or shell. */
function parseEnqueueArgs(argv: string[]) {
  let ref = "HEAD";
  let cwd = process.cwd();
  let provider: Provider | undefined;
  let model: string | undefined;
  let maxDiffChars = 60_000;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const readValue = () => {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${arg}.`);
      }
      index += 1;
      return value;
    };

    if (arg === "--cwd") {
      cwd = resolve(readValue());
    } else if (arg === "--provider") {
      const parsed = readValue();
      if (parsed !== "claude" && parsed !== "codex" && parsed !== "none") {
        throw new Error("--provider must be claude, codex, or none.");
      }
      provider = parsed;
    } else if (arg === "--model") {
      model = readValue();
    } else if (arg === "--max-diff-chars") {
      const parsed = Number.parseInt(readValue(), 10);
      if (!Number.isInteger(parsed) || parsed < 1_000) {
        throw new Error("--max-diff-chars must be an integer >= 1000.");
      }
      maxDiffChars = parsed;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      ref = arg;
    }
  }

  return {
    kind: "enqueue" as const,
    ref,
    options: {
      cwd,
      provider: provider ?? defaultProvider(),
      model,
      maxDiffChars,
    },
  };
}

/** Parse the single review id expected by simple manifest commands. */
function parseRequiredId(argv: string[], command: string) {
  const id = argv[0]?.trim();
  if (!id) {
    throw new Error(`Missing review id. Usage: tut ${command} <id>`);
  }
  return id;
}

/** Parse `tut fork provider:id [prompt]`. */
function parseForkArgs(argv: string[]) {
  const sessionRef = argv[0];
  if (!sessionRef) {
    throw new Error("Missing session reference. Expected `claude:<id>` or `codex:<id>`.");
  }
  const parsed = parseSessionRef(sessionRef);
  const prompt = argv.slice(1).join(" ").trim() || defaultForkPrompt(parsed);
  return { kind: "fork" as const, session: parsed, prompt };
}

/** Parse tutorial generation arguments. */
function parseGenerateArgs(argv: string[]) {
  let range: string | undefined;
  let about: string | undefined;
  let base: string | undefined;
  let includeUncommitted = false;
  let out: string | undefined;
  let sidecarOut: string | undefined;
  let tutorialJson: string | undefined;
  let provider: Provider | undefined;
  let model: string | undefined;
  let sourceSession: AgentSessionRef | undefined;
  let forkSession: AgentSessionRef | undefined;
  let cwd = process.cwd();
  let maxDiffChars = 60_000;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const readValue = () => {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${arg}.`);
      }
      index += 1;
      return value;
    };

    if (arg === "--about") {
      about = readValue();
    } else if (arg === "--base") {
      base = readValue();
    } else if (arg === "--include-uncommitted") {
      includeUncommitted = true;
    } else if (arg === "--out") {
      out = readValue();
    } else if (arg === "--sidecar-out") {
      sidecarOut = readValue();
    } else if (arg === "--tutorial-json") {
      tutorialJson = readValue();
    } else if (arg === "--provider") {
      const parsed = readValue();
      if (parsed !== "claude" && parsed !== "codex" && parsed !== "none") {
        throw new Error("--provider must be claude, codex, or none.");
      }
      provider = parsed;
    } else if (arg === "--model") {
      model = readValue();
    } else if (arg === "--source-session") {
      sourceSession = parseSessionRef(readValue());
    } else if (arg === "--fork-session") {
      forkSession = parseSessionRef(readValue());
    } else if (arg === "--cwd") {
      cwd = resolve(readValue());
    } else if (arg === "--max-diff-chars") {
      const parsed = Number.parseInt(readValue(), 10);
      if (!Number.isInteger(parsed) || parsed < 1_000) {
        throw new Error("--max-diff-chars must be an integer >= 1000.");
      }
      maxDiffChars = parsed;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!range) {
      range = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return {
    kind: "generate" as const,
    options: {
      cwd,
      range,
      base,
      about,
      includeUncommitted,
      out: out ? resolve(cwd, out) : undefined,
      sidecarOut: sidecarOut ? resolve(cwd, sidecarOut) : undefined,
      tutorialJson: tutorialJson ? resolve(cwd, tutorialJson) : undefined,
      provider: provider ?? defaultProvider(),
      model,
      maxDiffChars,
      sourceSession,
      forkSession,
    } satisfies GenerateOptions,
  };
}

/** Parse a provider-prefixed agent session reference. */
function parseSessionRef(raw: string): AgentSessionRef {
  const [provider, ...idParts] = raw.split(":");
  const id = idParts.join(":").trim();
  if ((provider !== "claude" && provider !== "codex") || id.length === 0) {
    throw new Error("Session reference must look like `claude:<id>` or `codex:<id>`.");
  }
  return { provider, id };
}

/** Parse a persisted session reference when present and valid. */
function maybeParseSessionRef(raw?: string): AgentSessionRef | undefined {
  if (!raw) {
    return undefined;
  }
  return parseSessionRef(raw);
}

/** Pick the first installed model provider, falling back to local heuristics. */
function defaultProvider(): Provider {
  if (commandExists("claude")) {
    return "claude";
  }
  if (commandExists("codex")) {
    return "codex";
  }
  return "none";
}

/** Return whether an executable is discoverable through the current shell PATH. */
function commandExists(name: string) {
  return Bun.spawnSync(["/usr/bin/env", "sh", "-lc", `command -v ${shellQuote(name)}`]).success;
}

/** Generate a tutorial, markdown file, and Hunk sidecar from the selected git diff. */
async function runGenerate(options: GenerateOptions) {
  const manifest = await generateReviewArtifacts(options);
  process.stdout.write(`saved ${manifest.id}\n`);
  process.stdout.write(`wrote ${manifest.markdownPath}\n`);
  process.stdout.write(`wrote ${manifest.sidecarPath}\n`);
  process.stdout.write(renderReviewHint(manifest));
}

/** Generate all durable files for one review, optionally into a pre-created queue item. */
async function generateReviewArtifacts(options: GenerateOptions, seed?: ReviewSeed) {
  const diffInput = collectDiffInput(options);
  const repoRoot = git(options.cwd, ["rev-parse", "--show-toplevel"]).trim();
  const repoName = detectRepoName(options.cwd);
  const createdAt = seed?.createdAt ?? new Date().toISOString();
  const reviewId = seed?.id ?? createReviewId(createdAt, repoName, diffInput.rangeLabel);
  const reviewDir = join(reviewsDir(), reviewId);
  mkdirSync(reviewDir, { recursive: true });
  const markdownPath = options.out ?? seed?.markdownPath ?? join(reviewDir, "tutorial.md");
  const sidecarPath = options.sidecarOut ?? seed?.sidecarPath ?? join(reviewDir, "tutorial.agent.json");
  const commitSha = seed?.commitSha ?? resolveRangeCommitSha(options.cwd, diffInput.rangeLabel);
  mkdirSync(dirname(markdownPath), { recursive: true });
  mkdirSync(dirname(sidecarPath), { recursive: true });

  const promptInput: PromptInput = {
    request: {
      focus: options.about,
      source_session: options.sourceSession
        ? `${options.sourceSession.provider}:${options.sourceSession.id}`
        : undefined,
      fork_session: options.forkSession
        ? `${options.forkSession.provider}:${options.forkSession.id}`
        : undefined,
    },
    repo: {
      name: repoName,
      root: repoRoot,
      head_sha: maybeGit(options.cwd, ["rev-parse", "HEAD"])?.trim() || undefined,
      base_ref: diffInput.baseRef,
      range: diffInput.rangeLabel,
    },
    files: extractFiles(diffInput.diff),
    unified_diff: boundedText(diffInput.diff, options.maxDiffChars),
  };

  const generated = await generateTutorial(options, promptInput);
  const sidecar = buildHunkSidecar(
    generated.tutorial,
    promptInput.files,
    extractFileHunkRanges(diffInput.diff),
    extractAddedLineIndex(diffInput.diff),
  );
  const markdown = renderMarkdown({
    tutorial: generated.tutorial,
    promptInput,
    rangeLabel: diffInput.rangeLabel,
    provider: options.provider,
    model: options.model,
    sessionId: generated.sessionId,
    sourceSession: options.sourceSession,
    forkSession: options.forkSession,
    sidecarOut: sidecarPath,
  });

  const manifest: ReviewManifest = {
    id: reviewId,
    createdAt,
    repoRoot,
    repoName,
    range: diffInput.rangeLabel,
    title: resolveReviewTitle(options.cwd, diffInput.rangeLabel),
    summary: generated.tutorial.executive_summary,
    markdownPath,
    sidecarPath,
    provider: options.provider,
    status: "ready",
    ...(commitSha ? { commitSha } : {}),
    ...(seed?.startedAt ? { startedAt: seed.startedAt } : {}),
    finishedAt: new Date().toISOString(),
    ...(seed?.logPath ? { logPath: seed.logPath } : {}),
    ...(seed?.workerPid ? { workerPid: seed.workerPid } : {}),
    maxDiffChars: options.maxDiffChars,
    ...(options.model ? { model: options.model } : {}),
    ...(generated.sessionId ? { sessionId: generated.sessionId } : {}),
    ...(options.sourceSession
      ? { sourceSession: `${options.sourceSession.provider}:${options.sourceSession.id}` }
      : {}),
    ...(options.forkSession
      ? { forkSession: `${options.forkSession.provider}:${options.forkSession.id}` }
      : {}),
  };

  writeFileSync(markdownPath, markdown);
  writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  writeManifest(manifest);
  return manifest;
}

interface DiffInput {
  diff: string;
  baseRef?: string;
  rangeLabel: string;
}

/** Collect a unified diff either from an explicit range or from base...HEAD. */
function collectDiffInput(options: GenerateOptions): DiffInput {
  const baseRef = options.range ? undefined : resolveBaseRef(options.cwd, options.base);
  const rangeLabel = options.range ?? `${baseRef}...HEAD`;
  let diff = git(options.cwd, ["diff", "--unified=3", rangeLabel]);

  if (options.includeUncommitted) {
    const staged = maybeGit(options.cwd, ["diff", "--cached", "--unified=3"]) ?? "";
    const unstaged = maybeGit(options.cwd, ["diff", "--unified=3"]) ?? "";
    if (staged.trim()) {
      diff += `\n\n# staged changes\n${staged}`;
    }
    if (unstaged.trim()) {
      diff += `\n\n# unstaged changes\n${unstaged}`;
    }
  }

  return { diff, baseRef, rangeLabel };
}

/** Build a filesystem-friendly review id. */
function createReviewId(createdAt: string, repoName: string, rangeLabel: string) {
  const timestamp = createdAt.replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  const repoPart = slugify(repoName.split("/").pop() ?? repoName).slice(0, 32) || "repo";
  const rangePart = slugify(rangeLabel).slice(0, 40) || "changes";
  return `${timestamp}-${repoPart}-${rangePart}`;
}

/** Return a concise title for one range when Git can provide one. */
function resolveReviewTitle(cwd: string, rangeLabel: string) {
  const end = rangeLabel.includes("..") ? rangeLabel.split("..").pop() : undefined;
  const ref = end?.replace(/^\./, "").trim() || "HEAD";
  const subject = maybeGit(cwd, ["log", "-1", "--format=%s", ref])?.trim();
  return subject || rangeLabel;
}

/** Resolve the post-image commit for one commit-shaped range when Git can identify it. */
function resolveRangeCommitSha(cwd: string, rangeLabel: string) {
  const end = rangeLabel.includes("..") ? rangeLabel.split("..").pop() : rangeLabel;
  const ref = end?.replace(/^\./, "").trim();
  if (!ref) {
    return undefined;
  }
  return maybeGit(cwd, ["rev-parse", `${ref}^{commit}`])?.trim() || undefined;
}

/** Resolve the default base branch using the same shape as Pika's local mode. */
function resolveBaseRef(cwd: string, explicit?: string) {
  if (explicit) {
    return explicit;
  }
  for (const candidate of ["origin/main", "main", "origin/master", "master"]) {
    if (Bun.spawnSync(["git", "rev-parse", "--verify", candidate], { cwd }).success) {
      return candidate;
    }
  }
  throw new Error(
    "Could not resolve a default base ref. Pass a range or use --base <ref>.",
  );
}

/** Run git and return stdout, throwing with stderr on failure. */
function git(cwd: string, args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
  if (!result.success) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

/** Run git and return null when the command fails. */
function maybeGit(cwd: string, args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
  return result.success ? result.stdout.toString() : null;
}

/** Generate with the selected provider, or use the local heuristic fallback. */
async function generateTutorial(
  options: GenerateOptions,
  input: PromptInput,
): Promise<GenerationOutput> {
  if (options.tutorialJson) {
    return { tutorial: parseTutorial(readFileSync(options.tutorialJson, "utf8")) };
  }
  if (options.provider === "none") {
    return { tutorial: heuristicFromDiff(input.unified_diff, input.request.focus) };
  }
  if (options.provider === "claude") {
    return generateWithClaude(input, options.model);
  }
  return generateWithCodex(input, options);
}

/** Ask Claude Code for a strict JSON tutorial. */
function generateWithClaude(input: PromptInput, model?: string): GenerationOutput {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--max-turns",
    "1",
    "--tools",
    "",
    ...(model ? ["--model", model] : []),
  ];
  const result = runWithStdin("claude", args, buildPrompt(input));
  const envelope = parseJsonObject(result.stdout, "Claude JSON envelope") as {
    result?: string;
    is_error?: boolean;
    subtype?: string;
    session_id?: string;
  };
  if (envelope.is_error) {
    throw new Error(`Claude returned an error: ${truncate(envelope.result ?? "", 600)}`);
  }
  if (envelope.subtype === "error_max_turns") {
    throw new Error("Claude hit the max-turns limit.");
  }
  return {
    tutorial: parseTutorial(envelope.result ?? ""),
    sessionId: envelope.session_id,
  };
}

/** Ask Codex exec for a strict JSON tutorial using its structured-output option. */
function generateWithCodex(input: PromptInput, options: GenerateOptions): GenerationOutput {
  const dir = mkdtempSync(join(tmpdir(), "tut-codex-"));
  const outputPath = join(dir, "last-message.json");
  const schemaPath = join(dir, "schema.json");
  writeFileSync(schemaPath, JSON.stringify(tutorialJsonSchema(), null, 2));

  const args =
    options.forkSession?.provider === "codex"
      ? [
          "exec",
          "resume",
          "--output-last-message",
          outputPath,
          ...(options.model ? ["--model", options.model] : []),
          options.forkSession.id,
          "-",
        ]
      : [
          "exec",
          "--output-last-message",
          outputPath,
          "--output-schema",
          schemaPath,
          "--ask-for-approval",
          "never",
          ...(options.model ? ["--model", options.model] : []),
          "-",
        ];
  const result = runWithStdin("codex", args, buildPrompt(input), options.cwd);
  if (!existsSync(outputPath)) {
    throw new Error(
      `codex did not write structured output: stdout=${truncate(result.stdout, 400)} stderr=${truncate(result.stderr, 800)}`,
    );
  }
  return {
    tutorial: parseTutorial(readFileSync(outputPath, "utf8")),
    sessionId: options.forkSession?.provider === "codex" ? options.forkSession.id : undefined,
  };
}

interface SpawnResultText {
  stdout: string;
  stderr: string;
}

/** Run a command with stdin and throw if it exits unsuccessfully. */
function runWithStdin(
  command: string,
  args: string[],
  stdin: string,
  cwd?: string,
): SpawnResultText {
  const codexPromptPath =
    command === "codex" ? join(mkdtempSync(join(tmpdir(), "tut-prompt-")), "prompt.txt") : undefined;
  if (codexPromptPath) {
    writeFileSync(codexPromptPath, stdin);
  }
  const executable = codexPromptPath ? "/bin/sh" : command;
  const commandArgs = codexPromptPath
    ? [
        "-lc",
        `${shellQuote(command)} ${args.map(shellQuote).join(" ")} < ${shellQuote(codexPromptPath)}`,
      ]
    : args;
  const result = spawnSync(executable, commandArgs, {
    ...(cwd ? { cwd } : {}),
    ...(codexPromptPath ? {} : { input: stdin }),
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${truncate(stderr, 800)}`);
  }
  if (!stdout.trim() && command !== "codex") {
    throw new Error(`${command} returned empty stdout: ${truncate(stderr, 800)}`);
  }
  return { stdout, stderr };
}

/** Build the model prompt and keep all structure in an encoded payload. */
function buildPrompt(input: PromptInput) {
  return [
    "You produce high-quality engineering tutorials from branch diffs.",
    "",
    "Create a code-change tutorial as strict JSON with this exact schema:",
    JSON.stringify(tutorialJsonSchema().properties, null, 2),
    "",
    "Rules:",
    "- Output JSON only.",
    "- Include exactly one executive summary paragraph.",
    "- Break the change into tutorial steps in narrative order.",
    "- Each step must include clear intent, affected files, evidence snippets linked to diff hunks, and markdown body text.",
    "- Evidence snippets should be compact factual strings, preferably unified-diff hunk headers such as @@ -10,3 +10,8 @@.",
    "- If request.source_session is present, treat it as provenance only; do not invent details from that session.",
    "- If request.fork_session is present, you are running inside that mutable fork of the source session. You may use the fork context, but cite the diff for concrete claims.",
    "- Focus on what changed, why it likely changed, and what a reviewer should verify.",
    "",
    "Input payload:",
    JSON.stringify(input, null, 2),
  ].join("\n");
}

/** JSON Schema accepted by Codex structured output and useful as prompt documentation. */
function tutorialJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      executive_summary: { type: "string" },
      media_links: {
        type: "array",
        items: { type: "string" },
      },
      steps: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            intent: { type: "string" },
            affected_files: { type: "array", items: { type: "string" } },
            evidence_snippets: { type: "array", items: { type: "string" } },
            body_markdown: { type: "string" },
          },
          required: [
            "title",
            "intent",
            "affected_files",
            "evidence_snippets",
            "body_markdown",
          ],
        },
      },
    },
    required: ["executive_summary", "media_links", "steps"],
  };
}

/** Parse and validate model output as the tutorial schema. */
function parseTutorial(raw: string): TutorialDoc {
  const doc = parseJsonObject(extractJsonPayload(raw), "tutorial JSON") as Partial<TutorialDoc>;
  if (!doc.executive_summary?.trim()) {
    throw new Error("Tutorial output is missing executive_summary.");
  }
  if (!Array.isArray(doc.media_links)) {
    throw new Error("Tutorial output is missing media_links.");
  }
  if (!Array.isArray(doc.steps) || doc.steps.length === 0) {
    throw new Error("Tutorial output is missing steps.");
  }
  for (const [index, step] of doc.steps.entries()) {
    if (!step?.title?.trim()) {
      throw new Error(`Tutorial output step ${index + 1} is missing title.`);
    }
    if (!step.intent?.trim()) {
      throw new Error(`Tutorial output step ${index + 1} is missing intent.`);
    }
    if (!Array.isArray(step.affected_files) || step.affected_files.length === 0) {
      throw new Error(`Tutorial output step ${index + 1} is missing affected_files.`);
    }
    if (!Array.isArray(step.evidence_snippets) || step.evidence_snippets.length === 0) {
      throw new Error(`Tutorial output step ${index + 1} is missing evidence_snippets.`);
    }
    if (!step.body_markdown?.trim()) {
      throw new Error(`Tutorial output step ${index + 1} is missing body_markdown.`);
    }
  }
  return doc as TutorialDoc;
}

/** Parse one JSON object with a useful context label. */
function parseJsonObject(raw: string, label: string) {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${label}: ${message}; prefix=${truncate(raw, 300)}`);
  }
}

/** Extract JSON from common fenced or prose-prefixed model output. */
export function extractJsonPayload(raw: string) {
  const trimmed = raw.trim();
  for (const marker of ["```json", "```JSON"]) {
    const start = trimmed.indexOf(marker);
    if (start !== -1) {
      const content = trimmed.slice(start + marker.length).trimStart();
      const end = content.indexOf("```");
      if (end !== -1) {
        return content.slice(0, end).trim();
      }
    }
  }
  if (trimmed.startsWith("```")) {
    const content = trimmed.slice(3).trimStart();
    const end = content.indexOf("```");
    if (end !== -1) {
      const candidate = content.slice(0, end).trim();
      if (candidate.startsWith("{")) {
        return candidate;
      }
    }
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

/** Build a deterministic fallback tutorial from diff headers. */
export function heuristicFromDiff(diff: string, focus?: string): TutorialDoc {
  const files = extractFiles(diff);
  const { additions, deletions } = countLineChanges(diff);
  const summary =
    files.length === 0
      ? "No file-level diff was detected. Verify the selected range or base reference."
      : `This change touches ${files.length} file(s) with ${additions} additions and ${deletions} deletions.${focus ? ` Requested focus: ${focus}.` : ""}`;

  return {
    executive_summary: summary,
    media_links: extractMediaLinks(diff),
    steps: files.slice(0, 12).map((file) => {
      const hunks = extractHunksForFile(diff, file);
      return {
        title: `Review ${file}`,
        intent: `Understand how ${file} contributes to the overall change.`,
        affected_files: [file],
        evidence_snippets: hunks.length > 0 ? hunks : ["No hunk headers were found for this file."],
        body_markdown: [
          "1. Read the hunk context.",
          "2. Identify the behavior or contract that changed.",
          "3. Check whether tests or manual verification cover the new behavior.",
        ].join("\n"),
      };
    }),
  };
}

/** Render a markdown tutorial document for humans. */
function renderMarkdown(input: {
  tutorial: TutorialDoc;
  promptInput: PromptInput;
  rangeLabel: string;
  provider: Provider;
  model?: string;
  sessionId?: string;
  sourceSession?: AgentSessionRef;
  forkSession?: AgentSessionRef;
  sidecarOut: string;
}) {
  const lines = [
    `# ${input.promptInput.repo.name} Change Tutorial`,
    "",
    `Range: \`${input.rangeLabel}\``,
    `Provider: \`${input.provider}${input.model ? `:${input.model}` : ""}\``,
  ];
  if (input.promptInput.request.focus) {
    lines.push(`Focus: ${input.promptInput.request.focus}`);
  }
  if (input.sourceSession) {
    lines.push(`Source session: \`${input.sourceSession.provider}:${input.sourceSession.id}\``);
  }
  if (input.forkSession) {
    lines.push(`Fork session: \`${input.forkSession.provider}:${input.forkSession.id}\``);
  }
  if (input.sessionId) {
    lines.push(`Tutorial session: \`${input.sessionId}\``);
  }
  lines.push(`Hunk sidecar: \`${input.sidecarOut}\``);
  lines.push("", "## Summary", "", input.tutorial.executive_summary, "", "## Steps", "");

  input.tutorial.steps.forEach((step, index) => {
    lines.push(`### ${index + 1}. ${step.title}`, "");
    lines.push(`Intent: ${step.intent}`, "");
    lines.push("Affected files:");
    for (const file of step.affected_files) {
      lines.push(`- \`${file}\``);
    }
    lines.push("", step.body_markdown, "", "Evidence:");
    for (const snippet of step.evidence_snippets) {
      lines.push(`- \`${snippet}\``);
    }
    lines.push("");
  });

  if (input.tutorial.media_links.length > 0) {
    lines.push("## Media", "");
    for (const link of input.tutorial.media_links) {
      lines.push(`- ${link}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** Convert tutorial steps into Hunk's existing agent-context sidecar schema. */
export function buildHunkSidecar(
  tutorial: TutorialDoc,
  diffFiles: string[],
  hunkRangesByFile: Map<string, ParsedHunkRange[]> = new Map(),
  addedLinesByFile: Map<string, AddedLine[]> = new Map(),
): AgentContext {
  const orderedFiles = orderedTutorialFiles(tutorial, diffFiles);
  return {
    version: 1,
    summary: tutorial.executive_summary,
    files: orderedFiles.map((path) => {
      const steps = tutorial.steps.filter((step) => step.affected_files.includes(path));
      return {
        path,
        summary: steps.map((step) => step.title).join("; ") || undefined,
        annotations: steps.flatMap((step) =>
          annotationsForStep(
            step,
            path,
            hunkRangesByFile.get(path) ?? [],
            addedLinesByFile.get(path) ?? [],
          ),
        ),
      };
    }),
  };
}

/** Preserve tutorial narrative order, then append any remaining diff files. */
function orderedTutorialFiles(tutorial: TutorialDoc, diffFiles: string[]) {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const step of tutorial.steps) {
    for (const file of step.affected_files) {
      if (!seen.has(file)) {
        seen.add(file);
        files.push(file);
      }
    }
  }
  for (const file of diffFiles) {
    if (!seen.has(file)) {
      files.push(file);
    }
  }
  return files;
}

/** Create hunk-specific annotations from one tutorial step's hunk evidence. */
function annotationsForStep(
  step: TutorialStep,
  path: string,
  fallbackRanges: ParsedHunkRange[],
  addedLines: AddedLine[],
): AgentAnnotation[] {
  const evidenceSnippets = step.evidence_snippets.filter((snippet) =>
    evidenceAppliesToPath(snippet, path, step.affected_files.length),
  );
  if (evidenceSnippets.length === 0) {
    return [];
  }

  const evidenceLineRange = evidenceSnippets
    .map((snippet) => resolveEvidenceLine(snippet, addedLines))
    .filter((range): range is ParsedHunkRange => range !== null);
  const hunkRange = evidenceSnippets
    .map((snippet) => parseUnifiedHunkHeader(snippet))
    .filter((range): range is ParsedHunkRange => range !== null);
  const range = evidenceLineRange[0] ?? hunkRange[0] ?? fallbackRanges[0];

  if (!range) {
    return [];
  }

  return [
    {
      ...(range.oldRange ? { oldRange: range.oldRange } : {}),
      ...(range.newRange ? { newRange: range.newRange } : {}),
      title: step.title,
      summary: step.intent,
      rationale: step.body_markdown,
      tags: ["tutorial"],
      source: "tut",
    },
  ];
}

/** Keep multi-file step notes attached only to evidence that names the current file. */
function evidenceAppliesToPath(snippet: string, path: string, affectedFileCount: number) {
  if (affectedFileCount <= 1) {
    return true;
  }
  const text = snippet.replaceAll("`", "");
  return text.includes(path) || text.includes(`/${path}`) || text.startsWith(`${basename(path)} `);
}

interface AddedLine {
  lineNumber: number;
  text: string;
}

/** Resolve a model-cited evidence line onto an exact added line in the diff. */
function resolveEvidenceLine(snippet: string, addedLines: AddedLine[]): ParsedHunkRange | null {
  const needle = normalizeEvidenceSnippet(snippet);
  if (!needle) {
    return null;
  }

  const exact = addedLines.find((line) => normalizeEvidenceText(line.text) === needle);
  const fuzzy =
    exact ??
    addedLines.find((line) => {
      const text = normalizeEvidenceText(line.text);
      return text.includes(needle) || needle.includes(text);
    });

  return fuzzy ? { newRange: [fuzzy.lineNumber, fuzzy.lineNumber] } : null;
}

/** Normalize model evidence by removing diff/markdown decoration while preserving code text. */
function normalizeEvidenceSnippet(snippet: string) {
  let text = snippet.trim();
  if (text.startsWith("`") && text.endsWith("`")) {
    text = text.slice(1, -1).trim();
  }
  if (text.startsWith("+") || text.startsWith("-")) {
    text = text.slice(1);
  }
  return normalizeEvidenceText(text);
}

/** Collapse whitespace for robust evidence matching. */
function normalizeEvidenceText(text: string) {
  return text.trim().replace(/\s+/g, " ");
}

/** Parse ranges from a unified diff hunk header. */
export function parseUnifiedHunkHeader(snippet: string) {
  const match = snippet.match(/@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?/);
  if (!match) {
    return null;
  }
  const oldStart = Number.parseInt(match[1]!, 10);
  const oldCount = Number.parseInt(match[2] ?? "1", 10);
  const newStart = Number.parseInt(match[3]!, 10);
  const newCount = Number.parseInt(match[4] ?? "1", 10);
  return {
    ...(oldCount > 0 && oldStart > 0
      ? { oldRange: [oldStart, oldStart + oldCount - 1] as [number, number] }
      : {}),
    ...(newCount > 0 && newStart > 0
      ? { newRange: [newStart, newStart + newCount - 1] as [number, number] }
      : {}),
  } satisfies ParsedHunkRange;
}

/** Extract parsed hunk ranges for every file in a unified diff. */
function extractFileHunkRanges(diff: string) {
  const rangesByFile = new Map<string, ParsedHunkRange[]>();
  let currentFile: string | null = null;

  for (const line of diff.split("\n")) {
    const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[2]!;
      if (!rangesByFile.has(currentFile)) {
        rangesByFile.set(currentFile, []);
      }
      continue;
    }

    if (!currentFile || !line.startsWith("@@")) {
      continue;
    }

    const parsed = parseUnifiedHunkHeader(line);
    if (parsed && (parsed.oldRange || parsed.newRange)) {
      rangesByFile.get(currentFile)!.push(parsed);
    }
  }

  return rangesByFile;
}

/** Build a per-file index of added lines and their post-image line numbers. */
function extractAddedLineIndex(diff: string) {
  const addedLinesByFile = new Map<string, AddedLine[]>();
  let currentFile: string | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of diff.split("\n")) {
    const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[2]!;
      oldLine = 0;
      newLine = 0;
      if (!addedLinesByFile.has(currentFile)) {
        addedLinesByFile.set(currentFile, []);
      }
      continue;
    }

    const hunk = parseUnifiedHunkHeader(line);
    if (hunk) {
      oldLine = hunk.oldRange?.[0] ?? 0;
      newLine = hunk.newRange?.[0] ?? 0;
      continue;
    }

    if (!currentFile || newLine === 0) {
      continue;
    }

    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }

    if (line.startsWith("+")) {
      addedLinesByFile.get(currentFile)!.push({
        lineNumber: newLine,
        text: line.slice(1),
      });
      newLine += 1;
      continue;
    }

    if (line.startsWith("-")) {
      oldLine += 1;
      continue;
    }

    oldLine += 1;
    newLine += 1;
  }

  return addedLinesByFile;
}

/** Extract file paths from unified diff file headers. */
function extractFiles(diff: string) {
  const files: string[] = [];
  for (const line of diff.split("\n")) {
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (!match) {
      continue;
    }
    const file = match[2]!;
    if (!files.includes(file)) {
      files.push(file);
    }
  }
  return files;
}

/** Count added and deleted content lines. */
function countLineChanges(diff: string) {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

/** Extract the first few hunk headers for one file. */
function extractHunksForFile(diff: string, file: string) {
  const hunks: string[] = [];
  let inFile = false;
  for (const line of diff.split("\n")) {
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (match) {
      inFile = match[2] === file || match[1] === file;
      continue;
    }
    if (inFile && line.startsWith("@@")) {
      hunks.push(line);
      if (hunks.length >= 3) {
        break;
      }
    }
  }
  return hunks;
}

/** Extract common image/video links embedded in text diffs. */
function extractMediaLinks(diff: string) {
  const links: string[] = [];
  for (const word of diff.split(/\s+/)) {
    if (
      word.startsWith("https://") &&
      /\.(png|jpe?g|gif|mp4)(\?|$)/i.test(word) &&
      !links.includes(word)
    ) {
      links.push(word);
    }
  }
  return links;
}

/** Return a compact diff prompt body while preserving a visible truncation marker. */
function boundedText(input: string, maxChars: number) {
  if (input.length <= maxChars) {
    return input;
  }
  return `${safePrefix(input, maxChars)}\n\n[diff truncated to ${maxChars} characters]`;
}

/** Detect a readable repository name from origin URL or the working tree directory. */
function detectRepoName(cwd: string) {
  const remote = maybeGit(cwd, ["config", "--get", "remote.origin.url"])?.trim();
  if (remote) {
    const withoutSuffix = remote.replace(/\.git$/, "");
    const githubIndex = withoutSuffix.indexOf("github.com/");
    if (githubIndex !== -1) {
      return withoutSuffix.slice(githubIndex + "github.com/".length);
    }
    const colonIndex = withoutSuffix.lastIndexOf(":");
    if (colonIndex !== -1 && withoutSuffix.slice(colonIndex + 1).includes("/")) {
      return withoutSuffix.slice(colonIndex + 1);
    }
  }
  return basename(git(cwd, ["rev-parse", "--show-toplevel"]).trim());
}

/** Return the durable review store root. */
function dataDir() {
  const dataRoot = process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share");
  const modern = join(dataRoot, "tut");
  const legacy = join(dataRoot, "hunk-tutorial");
  return (
    process.env["TUT_HOME"] ??
    process.env["HUNK_TUTORIAL_HOME"] ??
    (existsSync(modern) || !existsSync(legacy) ? modern : legacy)
  );
}

/** Return the active reviews directory, creating it on demand. */
function reviewsDir() {
  const dir = join(dataDir(), "reviews");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Return the archived reviews directory, creating it on demand. */
function archiveDir() {
  const dir = join(reviewsDir(), ".archive");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Return the durable directory for one review id. */
function reviewDir(id: string) {
  return join(reviewsDir(), id);
}

/** Return the manifest path for one review id. */
function manifestPath(id: string) {
  return join(reviewDir(id), "manifest.json");
}

/** Write one manifest atomically so the inbox never reads partial JSON. */
function writeManifest(manifest: ReviewManifest) {
  mkdirSync(reviewDir(manifest.id), { recursive: true });
  const path = manifestPath(manifest.id);
  const tempPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tempPath, path);
}

/** Convert arbitrary display text into a compact path component. */
function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Filter and sort active review manifests for list and inbox views. */
export function visibleReviewManifests(
  reviews: ReviewManifest[],
  { includeDone = false }: { includeDone?: boolean } = {},
) {
  return reviews
    .filter((review) => includeDone || !isReviewDone(review))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/** Load active review manifests sorted newest first. */
function loadReviewManifests(options: { includeDone?: boolean } = {}) {
  const reviews = readdirSync(reviewsDir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== ".archive")
    .flatMap((entry) => {
      const path = manifestPath(entry.name);
      if (!existsSync(path)) {
        return [];
      }
      try {
        return [JSON.parse(readFileSync(path, "utf8")) as ReviewManifest];
      } catch {
        return [];
      }
    });
  return visibleReviewManifests(reviews, options);
}

/** Find a review by id, id prefix, commit SHA prefix, or exact stored range. */
function findReview(idOrPrefix: string) {
  const reviews = loadReviewManifests({ includeDone: true });
  const resolvedCommitSha =
    maybeGit(process.cwd(), ["rev-parse", `${idOrPrefix}^{commit}`])?.trim() || undefined;
  const exact = reviews.find((review) => review.id === idOrPrefix);
  if (exact) {
    return exact;
  }
  const matches = reviews.filter(
    (review) =>
      reviewMatchesRef(review, idOrPrefix) ||
      (resolvedCommitSha !== undefined && review.commitSha === resolvedCommitSha),
  );
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length > 1) {
    throw new Error(`Review id prefix is ambiguous: ${idOrPrefix}`);
  }
  throw new Error(`No review found for id: ${idOrPrefix}`);
}

/** Match the common handles users have in hand when marking reviews. */
export function reviewMatchesRef(review: ReviewManifest, value: string) {
  const ref = value.trim();
  if (!ref) {
    return false;
  }
  return (
    review.id.startsWith(ref) ||
    review.commitSha?.startsWith(ref) ||
    review.range === ref ||
    review.range.startsWith(`${ref}^..`) ||
    review.range.endsWith(`..${ref}`)
  );
}

/** Treat old manifests without status as completed reviews. */
function reviewStatus(review: ReviewManifest): ReviewStatus {
  return review.status ?? "ready";
}

/** Return whether a completed review has been hidden from the default inbox. */
export function isReviewDone(review: ReviewManifest) {
  return Boolean(review.doneAt);
}

/** Print a compact table of generated reviews. */
function runList(includeDone = false) {
  const reviews = loadReviewManifests({ includeDone });
  if (reviews.length === 0) {
    process.stdout.write(
      includeDone
        ? `No reviews in ${reviewsDir()}\n`
        : `No active reviews in ${reviewsDir()} (use --all to include done reviews)\n`,
    );
    return;
  }
  for (const review of reviews) {
    const status = reviewStatus(review);
    const done = isReviewDone(review) ? " done" : "";
    process.stdout.write(
      `${review.id}  ${status}${done}  ${review.repoName}  ${review.range}  ${review.title}\n`,
    );
  }
}

/** Print active or failed background generation jobs. */
function runJobs() {
  const jobs = loadReviewManifests({ includeDone: true }).filter((review) => reviewStatus(review) !== "ready");
  if (jobs.length === 0) {
    process.stdout.write("No tutorial jobs.\n");
    return;
  }
  for (const review of jobs) {
    process.stdout.write(
      `${review.id}  ${reviewStatus(review)}  ${review.repoName}  ${review.range}  ${review.error ?? ""}\n`,
    );
  }
}

/** Move one review manifest directory into the archive folder. */
function archiveReview(id: string) {
  const review = findReview(id);
  const source = join(reviewsDir(), review.id);
  const target = join(archiveDir(), review.id);
  if (existsSync(target)) {
    throw new Error(`Archive target already exists: ${target}`);
  }
  renameSync(source, target);
  return review;
}

/** Move one review manifest directory into the archive folder. */
function runArchive(id: string) {
  const review = archiveReview(id);
  process.stdout.write(`archived ${review.id}\n`);
}

/** Mark one ready review as done so it leaves the default inbox. */
function runDone(id: string) {
  const review = findReview(id);
  assertReviewReady(review, "mark done");
  writeManifest({ ...review, doneAt: review.doneAt ?? new Date().toISOString() });
  process.stdout.write(`done ${review.id}\n`);
}

/** Restore one done review to the default inbox. */
function runUndone(id: string) {
  const review = findReview(id);
  const { doneAt: _doneAt, ...rest } = review;
  writeManifest(rest);
  process.stdout.write(`undone ${review.id}\n`);
}

/** Open one review in Hunk using its generated sidecar. */
async function runOpen(id: string) {
  const review = findReview(id);
  assertReviewReady(review, "open in Hunk");
  await spawnInteractive("hunk", [
    "diff",
    review.range,
    "--agent-context",
    review.sidecarPath,
    "--agent-notes",
  ], review.repoRoot);
}

/** Fail early for commands that need generated artifacts. */
function assertReviewReady(review: ReviewManifest, action: string) {
  const status = reviewStatus(review);
  if (status !== "ready") {
    throw new Error(`Review ${review.id} is ${status}; cannot ${action} yet.`);
  }
}

/** Queue tutorial generation for one commit and return immediately. */
function runEnqueue(
  ref: string,
  options: { cwd: string; provider: Provider; model?: string; maxDiffChars: number },
) {
  const repoRoot = git(options.cwd, ["rev-parse", "--show-toplevel"]).trim();
  const repoName = detectRepoName(repoRoot);
  const commitSha = git(repoRoot, ["rev-parse", `${ref}^{commit}`]).trim();
  const shortSha = git(repoRoot, ["rev-parse", "--short", commitSha]).trim();
  const existing = loadReviewManifests({ includeDone: true }).find(
    (review) => review.repoRoot === repoRoot && review.commitSha === commitSha,
  );
  if (existing) {
    process.stdout.write(`already queued ${existing.id} (${reviewStatus(existing)})\n`);
    return existing;
  }

  const createdAt = new Date().toISOString();
  const range = `${shortSha}^..${shortSha}`;
  const id = createReviewId(createdAt, repoName, range);
  const dir = reviewDir(id);
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, "worker.log");
  const manifest: ReviewManifest = {
    id,
    createdAt,
    repoRoot,
    repoName,
    range,
    title: resolveReviewTitle(repoRoot, commitSha),
    summary: "Tutorial generation is running in the background.",
    markdownPath: join(dir, "tutorial.md"),
    sidecarPath: join(dir, "tutorial.agent.json"),
    provider: options.provider,
    status: "generating",
    commitSha,
    startedAt: createdAt,
    logPath,
    maxDiffChars: options.maxDiffChars,
    ...(options.model ? { model: options.model } : {}),
  };
  writeManifest(manifest);
  const workerPid = startWorker(id, logPath);
  writeManifest({ ...manifest, workerPid });
  process.stdout.write(`queued ${id}\n`);
  return manifest;
}

/** Retry a failed or stale review by marking it generating and starting a fresh worker. */
function runRetry(id: string) {
  const review = findReview(id);
  const now = new Date().toISOString();
  const logPath = review.logPath ?? join(reviewDir(review.id), "worker.log");
  const manifest: ReviewManifest = {
    ...review,
    status: "generating",
    summary:
      review.summary && review.summary !== "Tutorial generation failed."
        ? review.summary
        : "Tutorial generation is running in the background.",
    startedAt: now,
    finishedAt: undefined,
    error: undefined,
    logPath,
  };
  writeManifest(manifest);
  const workerPid = startWorker(review.id, logPath);
  writeManifest({ ...manifest, workerPid });
  process.stdout.write(`retrying ${review.id}\n`);
}

/** Run a queued tutorial generation job inside the detached worker process. */
async function runWorker(id: string) {
  const manifest = findReview(id);
  const status = reviewStatus(manifest);
  if (status !== "generating") {
    return;
  }
  try {
    await generateReviewArtifacts(
      {
        cwd: manifest.repoRoot,
        range: manifest.range,
        includeUncommitted: false,
        provider: manifest.provider,
        model: manifest.model,
        maxDiffChars: manifest.maxDiffChars ?? 60_000,
      },
      {
        id: manifest.id,
        createdAt: manifest.createdAt,
        markdownPath: manifest.markdownPath,
        sidecarPath: manifest.sidecarPath,
        commitSha: manifest.commitSha,
        startedAt: manifest.startedAt,
        logPath: manifest.logPath,
        workerPid: process.pid,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeManifest({
      ...manifest,
      status: "failed",
      summary: "Tutorial generation failed.",
      finishedAt: new Date().toISOString(),
      error: truncate(message, 1200),
      workerPid: process.pid,
    });
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

/** Spawn the hidden background worker process and stream its logs to disk. */
function startWorker(id: string, logPath: string) {
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "a");
  const currentScript = process.argv[1];
  const launchArgs =
    currentScript && /\.(?:m?[jt]s|tsx)$/.test(currentScript)
      ? [currentScript, "worker", id]
      : ["worker", id];
  const child = spawn(process.execPath, launchArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();
  closeSync(logFd);
  return child.pid;
}

interface ChatCommand {
  command: string;
  args: string[];
  cwd: string;
}

/** Open the provider-owned chat UI for a review's associated agent session. */
async function runChat(id?: string) {
  const review = id ? findReview(id) : findDefaultChatReview(process.cwd());
  assertReviewReady(review, "open chat");
  const command = chatCommandForReview(review);
  await spawnInteractive(command.command, command.args, command.cwd);
}

/** Choose the newest review for the current repo, falling back to the newest global review. */
function findDefaultChatReview(cwd: string) {
  const reviews = loadReviewManifests();
  if (reviews.length === 0) {
    throw new Error(`No reviews in ${reviewsDir()}`);
  }
  const repoRoot = maybeGit(cwd, ["rev-parse", "--show-toplevel"])?.trim();
  return reviews.find((review) => repoRoot && review.repoRoot === repoRoot) ?? reviews[0]!;
}

/** Build the interactive provider command for a review without taking over chat rendering. */
export function chatCommandForReview(review: ReviewManifest): ChatCommand {
  const forkSession = maybeParseSessionRef(review.forkSession);
  if (forkSession) {
    return resumeSessionCommand(forkSession, review.repoRoot);
  }

  if (review.provider === "codex" && review.sessionId) {
    return resumeSessionCommand({ provider: "codex", id: review.sessionId }, review.repoRoot);
  }
  if (review.provider === "claude" && review.sessionId) {
    return resumeSessionCommand({ provider: "claude", id: review.sessionId }, review.repoRoot);
  }

  const sourceSession = maybeParseSessionRef(review.sourceSession);
  if (sourceSession) {
    return forkSessionCommand(sourceSession, reviewChatPrompt(review), review.repoRoot);
  }

  throw new Error(
    `Review ${review.id} has no forkSession, provider sessionId, or sourceSession to chat with.`,
  );
}

/** Build a provider resume command for an existing mutable chat session. */
function resumeSessionCommand(session: AgentSessionRef, cwd: string): ChatCommand {
  if (session.provider === "codex") {
    return { command: "codex", args: ["resume", session.id], cwd };
  }
  return { command: "claude", args: ["-r", session.id], cwd };
}

/** Build a provider fork command so source sessions are not mutated. */
function forkSessionCommand(session: AgentSessionRef, prompt: string, cwd: string): ChatCommand {
  if (session.provider === "codex") {
    return { command: "codex", args: ["fork", session.id, prompt], cwd };
  }
  return { command: "claude", args: ["-r", session.id, "--fork-session", prompt], cwd };
}

/** Seed a forked chat with the review artifacts the user is looking at. */
function reviewChatPrompt(review: ReviewManifest) {
  return [
    "I am reviewing a generated Hunk tutorial and want follow-up help.",
    `Repo: ${review.repoName}`,
    `Repo root: ${review.repoRoot}`,
    `Range: ${review.range}`,
    `Tutorial markdown: ${review.markdownPath}`,
    `Hunk sidecar: ${review.sidecarPath}`,
    "Please answer questions in the context of this review and cite concrete files or hunks when useful.",
  ].join("\n");
}

/** Spawn one command attached to the current terminal. */
async function spawnInteractive(command: string, args: string[], cwd: string) {
  const child = Bun.spawn([command, ...args], {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) {
    throw new Error(`${command} exited with code ${code}`);
  }
}

interface InboxState {
  reviews: ReviewManifest[];
  selected: number;
  scroll: number;
}

/** Run the OpenTUI tutorial inbox. */
async function runInbox(includeDone = false) {
  const reviews = loadReviewManifests({ includeDone });
  if (reviews.length === 0) {
    process.stdout.write(
      includeDone
        ? `No reviews in ${reviewsDir()}\n`
        : `No active reviews in ${reviewsDir()} (use --all to include done reviews)\n`,
    );
    return;
  }

  const renderer = await createCliRenderer({
    stdout: process.stdout,
    useMouse: true,
    exitOnCtrlC: false,
    openConsoleOnError: true,
  });
  const root = createRoot(renderer);

  await new Promise<void>((resolveQuit) => {
    const shutdown = () => {
      root.unmount();
      renderer.destroy();
      resolveQuit();
    };
    root.render(createElement(InboxApp, { initialReviews: reviews, includeDone, onQuit: shutdown }));
  });
}

/** Render the inbox and keep it alive while child tools are suspended. */
function InboxApp({
  initialReviews,
  includeDone,
  onQuit,
}: {
  initialReviews: ReviewManifest[];
  includeDone: boolean;
  onQuit: () => void;
}) {
  const renderer = useRenderer();
  const terminal = useTerminalDimensions();
  const [reviews, setReviews] = useState(initialReviews);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => {
      const nextReviews = loadReviewManifests({ includeDone });
      setReviews(nextReviews);
      setSelected((current) => Math.min(current, Math.max(0, nextReviews.length - 1)));
    }, 1000);
    return () => clearInterval(timer);
  }, [includeDone]);

  const selectedReview = reviews[selected];
  const listWidth = Math.min(42, Math.max(28, Math.floor(terminal.width * 0.34)));
  const detailWidth = Math.max(20, terminal.width - listWidth - 1);
  const bodyHeight = Math.max(1, terminal.height - 3);
  const scroll = visibleInboxScroll(selected, reviews.length, bodyHeight);
  const visibleReviews = reviews.slice(scroll, scroll + bodyHeight);
  const previewLines = useMemo(
    () => (selectedReview ? renderReviewPreview(selectedReview, detailWidth - 2, bodyHeight) : []),
    [bodyHeight, detailWidth, selectedReview],
  );

  const launchReview = useCallback(
    async (review: ReviewManifest, mode: "hunk" | "markdown") => {
      setBusy(mode === "hunk" ? "Opening Hunk..." : "Opening markdown...");
      setMessage(null);
      renderer.suspend();
      try {
        if (mode === "hunk") {
          await spawnInteractive(
            "hunk",
            ["diff", review.range, "--agent-context", review.sidecarPath, "--agent-notes"],
            review.repoRoot,
          );
        } else {
          const pager = process.env["PAGER"]?.trim() || "less -R";
          await spawnInteractive("/bin/sh", ["-lc", `${pager} ${shellQuote(review.markdownPath)}`], review.repoRoot);
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      } finally {
        if (!renderer.isDestroyed) {
          renderer.resume();
        }
        setBusy(null);
      }
    },
    [renderer],
  );

  const launchChat = useCallback(
    async (review: ReviewManifest) => {
      setBusy("Opening chat...");
      setMessage(null);
      renderer.suspend();
      try {
        const command = chatCommandForReview(review);
        await spawnInteractive(command.command, command.args, command.cwd);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      } finally {
        if (!renderer.isDestroyed) {
          renderer.resume();
        }
        setBusy(null);
      }
    },
    [renderer],
  );

  useKeyboard((key: KeyEvent) => {
    if (busy) {
      return;
    }
    if (isQuitKey(key)) {
      onQuit();
      return;
    }
    if (isUpKey(key)) {
      setSelected((current) => Math.max(0, current - 1));
      return;
    }
    if (isDownKey(key)) {
      setSelected((current) => Math.min(reviews.length - 1, current + 1));
      return;
    }
    if (isEnterKey(key) && selectedReview) {
      if (reviewStatus(selectedReview) !== "ready") {
        setMessage(`Review is ${reviewStatus(selectedReview)}.`);
        return;
      }
      void launchReview(selectedReview, "hunk");
      return;
    }
    if (isPlainKey(key, "m") && selectedReview) {
      if (reviewStatus(selectedReview) !== "ready") {
        setMessage(`Review is ${reviewStatus(selectedReview)}.`);
        return;
      }
      void launchReview(selectedReview, "markdown");
      return;
    }
    if (isPlainKey(key, "c") && selectedReview) {
      if (reviewStatus(selectedReview) !== "ready") {
        setMessage(`Review is ${reviewStatus(selectedReview)}.`);
        return;
      }
      void launchChat(selectedReview);
      return;
    }
    if (isPlainKey(key, "r") && selectedReview) {
      runRetry(selectedReview.id);
      setReviews(loadReviewManifests({ includeDone }));
      setMessage(`Retrying ${selectedReview.id}`);
      return;
    }
    if (isPlainKey(key, "x") && selectedReview) {
      runDone(selectedReview.id);
      const nextReviews = loadReviewManifests({ includeDone });
      if (nextReviews.length === 0) {
        onQuit();
        return;
      }
      setReviews(nextReviews);
      setSelected((current) => Math.min(current, nextReviews.length - 1));
      setMessage(`Done ${selectedReview.id}`);
      return;
    }
    if (isPlainKey(key, "u") && selectedReview) {
      runUndone(selectedReview.id);
      setReviews(loadReviewManifests({ includeDone }));
      setMessage(`Undone ${selectedReview.id}`);
      return;
    }
    if (isPlainKey(key, "d") && selectedReview) {
      archiveReview(selectedReview.id);
      const nextReviews = loadReviewManifests({ includeDone });
      if (nextReviews.length === 0) {
        onQuit();
        return;
      }
      setReviews(nextReviews);
      setSelected((current) => Math.min(current, nextReviews.length - 1));
      setMessage(`Archived ${selectedReview.id}`);
    }
  });

  return h(
    "box",
    { style: { width: "100%", height: "100%", flexDirection: "column", backgroundColor: "#111318" } },
    h(
      "box",
      { style: { width: "100%", height: 1, flexDirection: "row" } },
      h("text", { fg: "#d7dde8" }, fit(" Reviews", listWidth)),
      h("text", { fg: "#5f6878" }, "│"),
      h("text", { fg: "#d7dde8" }, fit(" Tutorial", detailWidth)),
    ),
    h(
      "box",
      { style: { width: "100%", height: bodyHeight, flexDirection: "row" } },
      h(
        "box",
        { style: { width: listWidth, height: bodyHeight, flexDirection: "column" } },
        ...visibleReviews.map((review, index) => {
          const absolute = scroll + index;
          const active = absolute === selected;
          const status = reviewStatus(review);
          const suffix = isReviewDone(review)
            ? " [done]"
            : status === "ready"
              ? ""
              : ` [${status}]`;
          const title = `${review.repoName.split("/").pop()} ${review.range}${suffix}`;
          return h("text", { key: review.id, fg: active ? "#f5f7fb" : "#aab2c0" }, fit(`${active ? ">" : " "} ${title}`, listWidth));
        }),
      ),
      h("text", { fg: "#5f6878" }, "│"),
      h(
        "box",
        { style: { width: detailWidth, height: bodyHeight, flexDirection: "column", paddingLeft: 1 } },
        ...previewLines.slice(0, bodyHeight).map((line, index) =>
          h("text", { key: `${index}-${line}`, fg: previewColor(line, index) }, fit(line, detailWidth - 1)),
        ),
      ),
    ),
    h(
      "box",
      { style: { width: "100%", height: 2, flexDirection: "column" } },
      h(
        "text",
        { fg: busy ? "#f2c97d" : "#8e98aa" },
        fit(busy ?? "Enter: Hunk  c: chat  m: markdown  x: done  u: undone  r: retry  d: archive  j/k: move  q: quit", terminal.width),
      ),
      h("text", { fg: "#c77d7d" }, fit(message ?? "", terminal.width)),
    ),
  );
}

/** Create OpenTUI intrinsic elements without converting this CLI file to TSX. */
function h(type: string, props: Record<string, unknown> | null, ...children: ReactNode[]) {
  return createElement(type, props as never, ...children);
}

/** Keep the selected row visible in the review list. */
function visibleInboxScroll(selected: number, total: number, height: number) {
  if (total <= height) {
    return 0;
  }
  return Math.min(Math.max(0, selected - height + 1), Math.max(0, total - height));
}

/** Color preview lines by rough document role. */
function previewColor(line: string, index: number) {
  if (index === 0) {
    return "#f5f7fb";
  }
  if (line === "Summary" || line === "Steps" || line === "Generating" || line === "Log tail") {
    return "#93c5fd";
  }
  if (line === "Failed") {
    return "#fca5a5";
  }
  if (/^\d+\./.test(line)) {
    return "#d7dde8";
  }
  return "#aab2c0";
}

/** Detect quit shortcuts in OpenTUI key events. */
function isQuitKey(key: KeyEvent) {
  return isPlainKey(key, "q") || key.name === "c" && key.ctrl;
}

/** Detect up movement shortcuts. */
function isUpKey(key: KeyEvent) {
  return isPlainKey(key, "k") || key.name === "up";
}

/** Detect down movement shortcuts. */
function isDownKey(key: KeyEvent) {
  return isPlainKey(key, "j") || key.name === "down";
}

/** Detect enter/return. */
function isEnterKey(key: KeyEvent) {
  return key.name === "return" || key.name === "enter" || key.sequence === "\r";
}

/** Detect an unmodified printable key. */
function isPlainKey(key: KeyEvent, value: string) {
  return (
    (key.name === value || key.sequence === value) &&
    !key.shift &&
    !key.option &&
    !key.ctrl &&
    !key.meta
  );
}

/** Build wrapped preview lines for one review. */
function renderReviewPreview(review: ReviewManifest, width: number, height: number) {
  const lines: string[] = [];
  lines.push(review.title);
  lines.push(`${review.repoName}  ${review.range}`);
  if (review.doneAt) {
    lines.push(`Done: ${review.doneAt}`);
  }
  lines.push("");
  const status = reviewStatus(review);
  if (status !== "ready") {
    lines.push(status === "generating" ? "Generating" : "Failed");
    lines.push(...wrap(status === "generating" ? "Tutorial generation is running in the background." : (review.error ?? "Tutorial generation failed."), width));
    if (review.startedAt) {
      lines.push(`Started: ${review.startedAt}`);
    }
    if (review.finishedAt) {
      lines.push(`Finished: ${review.finishedAt}`);
    }
    if (review.logPath) {
      lines.push(`Log: ${review.logPath}`);
      const logLines = tailTextFile(review.logPath, Math.max(0, height - lines.length - 2));
      if (logLines.length > 0) {
        lines.push("");
        lines.push("Log tail");
        lines.push(...logLines);
      }
    }
    return lines.flatMap((line) => (line.length > width ? wrap(line, width) : [line]));
  }

  lines.push("Summary");
  lines.push(...wrap(review.summary, width));

  const markdown = existsSync(review.markdownPath)
    ? readFileSync(review.markdownPath, "utf8")
    : "";
  const steps = extractMarkdownStepTitles(markdown);
  if (steps.length > 0) {
    lines.push("");
    lines.push("Steps");
    steps.slice(0, Math.max(0, height - lines.length - 1)).forEach((step, index) => {
      lines.push(fit(`${index + 1}. ${step}`, width));
    });
  }

  return lines.flatMap((line) => (line.length > width ? wrap(line, width) : [line]));
}

/** Read a small tail from a log file for generating and failed reviews. */
function tailTextFile(path: string, maxLines: number) {
  if (maxLines <= 0 || !existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(-maxLines);
}

/** Extract `### N. title` step titles from generated markdown. */
function extractMarkdownStepTitles(markdown: string) {
  return markdown
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/^###\s+\d+\.\s+(.+)$/);
      return match ? [match[1]!] : [];
    });
}

/** Fit one line into a fixed terminal width. */
function fit(value: string, width: number) {
  const plain = value.replace(/\t/g, " ");
  if (plain.length <= width) {
    return plain + " ".repeat(width - plain.length);
  }
  return plain.slice(0, Math.max(0, width - 1)) + "…";
}

/** Wrap text to a terminal width. */
function wrap(value: string, width: number) {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length === 0) {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) {
    lines.push(line);
  }
  return lines.length > 0 ? lines : [""];
}

/** Render a command users can run to inspect generated sidecar notes inside Hunk. */
function renderReviewHint(manifest: ReviewManifest) {
  return [
    "",
    "review in Hunk:",
    `  cd ${shellQuote(manifest.repoRoot)} && hunk diff ${shellQuote(manifest.range)} --agent-context ${shellQuote(manifest.sidecarPath)} --agent-notes`,
    "",
    "review inbox:",
    "  tut inbox",
    "",
    manifest.sourceSession
      ? `fork source session:\n  tut fork ${manifest.sourceSession}\n`
      : "",
    manifest.forkSession
      ? `continue tutorial fork:\n  tut fork ${manifest.forkSession}\n`
      : "",
  ]
    .filter(Boolean)
    .join("\n") + "\n";
}

/** Launch an interactive fork/resume for a provider session. */
async function runFork(session: AgentSessionRef, prompt: string) {
  const args =
    session.provider === "codex"
      ? ["fork", session.id, prompt]
      : ["-r", session.id, "--fork-session", prompt];
  const executable = session.provider === "codex" ? "codex" : "claude";
  const child = Bun.spawn([executable, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  process.exit(code ?? 0);
}

/** Provide a useful prompt when the user only supplies a session id. */
function defaultForkPrompt(session: AgentSessionRef) {
  return [
    "I am reviewing the changes you worked on.",
    `You are being forked from session ${session.provider}:${session.id}.`,
    "Please explain the implementation as a step-by-step tutorial, cite concrete files and hunks, and call out review risks.",
  ].join(" ");
}

/** Shell-quote one argument for display only. */
function shellQuote(value: string) {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Return a Unicode-safe string prefix. */
function safePrefix(input: string, max: number) {
  let end = Math.min(input.length, max);
  while (end > 0 && !isCharBoundary(input, end)) {
    end -= 1;
  }
  return input.slice(0, end);
}

/** Check UTF-16 surrogate boundaries for safe slicing. */
function isCharBoundary(input: string, index: number) {
  const code = input.charCodeAt(index);
  return Number.isNaN(code) || code < 0xdc00 || code > 0xdfff;
}

/** Truncate error text for readable CLI failures. */
function truncate(input: string, max: number) {
  return input.length <= max ? input : `${safePrefix(input, max)}...`;
}

if (import.meta.main) {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.kind === "help") {
      process.stdout.write(usage());
    } else if (parsed.kind === "fork") {
      await runFork(parsed.session, parsed.prompt);
    } else if (parsed.kind === "inbox") {
      await runInbox(parsed.includeDone);
    } else if (parsed.kind === "list") {
      runList(parsed.includeDone);
    } else if (parsed.kind === "open") {
      await runOpen(parsed.id);
    } else if (parsed.kind === "chat") {
      await runChat(parsed.id);
    } else if (parsed.kind === "enqueue") {
      runEnqueue(parsed.ref, parsed.options);
    } else if (parsed.kind === "retry") {
      runRetry(parsed.id);
    } else if (parsed.kind === "jobs") {
      runJobs();
    } else if (parsed.kind === "done") {
      runDone(parsed.id);
    } else if (parsed.kind === "undone") {
      runUndone(parsed.id);
    } else if (parsed.kind === "worker") {
      await runWorker(parsed.id);
    } else if (parsed.kind === "archive") {
      runArchive(parsed.id);
    } else {
      await runGenerate(parsed.options);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`tut: ${message}\n\n${usage()}`);
    process.exit(1);
  }
}
