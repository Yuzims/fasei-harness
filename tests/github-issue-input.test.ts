import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubIssueInputError,
  INVALID_GITHUB_ISSUE_INPUT,
  parseGitHubIssueInput,
} from "../src/github/issue-input.js";

function parse(input: string) {
  return parseGitHubIssueInput(input);
}

function rejects(input: string, reason?: string) {
  assert.throws(
    () => parseGitHubIssueInput(input),
    (error: unknown) =>
      error instanceof GitHubIssueInputError &&
      error.code === INVALID_GITHUB_ISSUE_INPUT &&
      (reason ? error.reason === reason : true),
  );
}

test("Parser：valid GitHub Issue URL", () => {
  const parsed = parse("https://github.com/microsoft/vscode/issues/258694");
  assert.equal(parsed.owner, "microsoft");
  assert.equal(parsed.repository, "vscode");
  assert.equal(parsed.issueNumber, 258694);
  assert.equal(parsed.url, "https://github.com/microsoft/vscode/issues/258694");
});

test("Parser：valid owner/repo#number", () => {
  const parsed = parse("microsoft/vscode#258694");
  assert.equal(parsed.owner, "microsoft");
  assert.equal(parsed.repository, "vscode");
  assert.equal(parsed.issueNumber, 258694);
});

test("Parser：trailing slash", () => {
  const parsed = parse("https://github.com/microsoft/vscode/issues/258694/");
  assert.equal(parsed.issueNumber, 258694);
  assert.equal(parsed.repository, "vscode");
});

test("Parser：invalid input", () => {
  rejects("hello world", "unrecognized");
  rejects("", "empty");
});

test("Parser：PR URL rejected", () => {
  rejects("https://github.com/microsoft/vscode/pull/123", "pull_request");
});

test("Parser：non-GitHub URL rejected", () => {
  rejects("https://gitlab.com/foo/bar/issues/1", "unsupported_host");
});

test("Parser：invalid issue number rejected", () => {
  rejects("microsoft/vscode#abc", "invalid_issue_number");
  rejects("microsoft/vscode", "missing_issue_number");
});
