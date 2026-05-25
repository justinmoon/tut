import { describe, expect, test } from "bun:test";
import {
  buildHunkSidecar,
  chatCommandForReview,
  extractJsonPayload,
  heuristicFromDiff,
  isReviewDone,
  parseUnifiedHunkHeader,
  reviewMatchesRef,
  visibleReviewManifests,
} from "./main.ts";

describe("tut helpers", () => {
  test("extracts fenced model JSON", () => {
    expect(extractJsonPayload("Here:\n```json\n{\"executive_summary\":\"ok\"}\n```")).toBe(
      "{\"executive_summary\":\"ok\"}",
    );
  });

  test("parses unified hunk ranges", () => {
    expect(parseUnifiedHunkHeader("@@ -10,2 +12,4 @@ function demo")).toEqual({
      oldRange: [10, 11],
      newRange: [12, 15],
    });
  });

  test("omits zero-count hunk ranges", () => {
    expect(parseUnifiedHunkHeader("@@ -0,0 +1,17 @@")).toEqual({
      newRange: [1, 17],
    });
  });

  test("heuristic tutorial can become a Hunk sidecar", () => {
    const diff = [
      "diff --git a/src/demo.ts b/src/demo.ts",
      "index 1111111..2222222 100644",
      "--- a/src/demo.ts",
      "+++ b/src/demo.ts",
      "@@ -1,1 +1,2 @@",
      "-old",
      "+new",
      "+line",
    ].join("\n");

    const tutorial = heuristicFromDiff(diff, "demo focus");
    const sidecar = buildHunkSidecar(
      tutorial,
      ["src/demo.ts"],
      new Map([["src/demo.ts", [{ newRange: [1, 2] }]]]),
      new Map([["src/demo.ts", [{ lineNumber: 1, text: "new" }]]]),
    );

    expect(sidecar.files[0]?.path).toBe("src/demo.ts");
    expect(sidecar.files[0]?.annotations[0]?.newRange).toEqual([1, 2]);
    expect(sidecar.files[0]?.annotations[0]?.tags).toEqual(["tutorial"]);
  });

  test("anchors model evidence lines to exact added lines", () => {
    const tutorial = {
      executive_summary: "summary",
      media_links: [],
      steps: [
        {
          title: "State model",
          intent: "Explain the state model.",
          affected_files: ["src/demo.ts"],
          evidence_snippets: ["+pub struct AppState {"],
          body_markdown: "The state model starts here.",
        },
      ],
    };

    const sidecar = buildHunkSidecar(
      tutorial,
      ["src/demo.ts"],
      new Map([["src/demo.ts", [{ newRange: [1, 20] }]]]),
      new Map([
        [
          "src/demo.ts",
          [
            { lineNumber: 4, text: "use crate::x;" },
            { lineNumber: 12, text: "pub struct AppState {" },
          ],
        ],
      ]),
    );

    expect(sidecar.files[0]?.annotations[0]?.newRange).toEqual([12, 12]);
  });

  test("does not reuse one file evidence across every file in a multi-file step", () => {
    const tutorial = {
      executive_summary: "summary",
      media_links: [],
      steps: [
        {
          title: "Workspace wiring",
          intent: "Explain workspace wiring.",
          affected_files: ["Cargo.toml", "uniffi-bindgen/src/main.rs"],
          evidence_snippets: ["Cargo.toml @@ -8,6 +8,7 @@ members = ["],
          body_markdown: "The workspace adds the generator crate.",
        },
      ],
    };

    const sidecar = buildHunkSidecar(
      tutorial,
      ["Cargo.toml", "uniffi-bindgen/src/main.rs"],
      new Map([
        ["Cargo.toml", [{ newRange: [8, 14] }]],
        ["uniffi-bindgen/src/main.rs", [{ newRange: [1, 3] }]],
      ]),
    );

    expect(sidecar.files.find((file) => file.path === "Cargo.toml")?.annotations).toHaveLength(1);
    expect(
      sidecar.files.find((file) => file.path === "uniffi-bindgen/src/main.rs")?.annotations,
    ).toHaveLength(0);
  });

  test("chat command resumes a recorded codex fork session", () => {
    const command = chatCommandForReview({
      id: "review-1",
      createdAt: "2026-05-24T00:00:00.000Z",
      repoRoot: "/repo",
      repoName: "owner/repo",
      range: "abc^..abc",
      title: "demo",
      summary: "summary",
      markdownPath: "/review/tutorial.md",
      sidecarPath: "/review/tutorial.agent.json",
      provider: "codex",
      forkSession: "codex:forked-session",
    });

    expect(command).toEqual({
      command: "codex",
      args: ["resume", "forked-session"],
      cwd: "/repo",
    });
  });

  test("chat command resumes a recorded review session first", () => {
    const command = chatCommandForReview({
      id: "review-1",
      createdAt: "2026-05-24T00:00:00.000Z",
      repoRoot: "/repo",
      repoName: "owner/repo",
      range: "abc^..abc",
      title: "demo",
      summary: "summary",
      markdownPath: "/review/tutorial.md",
      sidecarPath: "/review/tutorial.agent.json",
      provider: "codex",
      reviewSession: "codex:review-session",
      sourceSession: "codex:source-session",
    });

    expect(command).toEqual({
      command: "codex",
      args: ["resume", "review-session"],
      cwd: "/repo",
    });
  });

  test("chat command forks a recorded codex source session", () => {
    const command = chatCommandForReview({
      id: "review-1",
      createdAt: "2026-05-24T00:00:00.000Z",
      repoRoot: "/repo",
      repoName: "owner/repo",
      range: "abc^..abc",
      title: "demo",
      summary: "summary",
      markdownPath: "/review/tutorial.md",
      sidecarPath: "/review/tutorial.agent.json",
      provider: "codex",
      sourceSession: "codex:source-session",
    });

    expect(command.command).toBe("codex");
    expect(command.args[0]).toBe("fork");
    expect(command.args[1]).toBe("source-session");
    expect(command.args[2]).toContain("Range: abc^..abc");
    expect(command.cwd).toBe("/repo");
  });

  test("chat command prefers tutorial provider session over source session", () => {
    const command = chatCommandForReview({
      id: "review-1",
      createdAt: "2026-05-24T00:00:00.000Z",
      repoRoot: "/repo",
      repoName: "owner/repo",
      range: "abc^..abc",
      title: "demo",
      summary: "summary",
      markdownPath: "/review/tutorial.md",
      sidecarPath: "/review/tutorial.agent.json",
      provider: "claude",
      sessionId: "claude-tutorial-session",
      sourceSession: "codex:source-session",
    });

    expect(command).toEqual({
      command: "claude",
      args: ["-r", "claude-tutorial-session"],
      cwd: "/repo",
    });
  });

  test("review matching accepts commit prefixes and exact ranges", () => {
    const review = {
      id: "2026-demo-abcdef0",
      createdAt: "2026-05-24T00:00:00.000Z",
      repoRoot: "/repo",
      repoName: "owner/repo",
      range: "abcdef0^..abcdef0",
      title: "demo",
      summary: "summary",
      markdownPath: "/review/tutorial.md",
      sidecarPath: "/review/tutorial.agent.json",
      provider: "claude" as const,
      commitSha: "abcdef0123456789",
    };

    expect(reviewMatchesRef(review, "abcdef0")).toBe(true);
    expect(reviewMatchesRef(review, "abcdef0123")).toBe(true);
    expect(reviewMatchesRef(review, "abcdef0^..abcdef0")).toBe(true);
    expect(reviewMatchesRef(review, "1234567")).toBe(false);
  });

  test("done reviews are hidden unless requested", () => {
    const ready = {
      id: "ready",
      createdAt: "2026-05-24T00:00:00.000Z",
      repoRoot: "/repo",
      repoName: "owner/repo",
      range: "a^..a",
      title: "ready",
      summary: "summary",
      markdownPath: "/review/tutorial.md",
      sidecarPath: "/review/tutorial.agent.json",
      provider: "claude" as const,
    };
    const done = { ...ready, id: "done", createdAt: "2026-05-25T00:00:00.000Z", doneAt: "2026-05-25T01:00:00.000Z" };

    expect(isReviewDone(done)).toBe(true);
    expect(visibleReviewManifests([ready, done]).map((review) => review.id)).toEqual(["ready"]);
    expect(
      visibleReviewManifests([ready, done], { includeDone: true }).map((review) => review.id),
    ).toEqual(["done", "ready"]);
  });
});
