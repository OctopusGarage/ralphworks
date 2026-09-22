import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ARCHITECTURE_WORKFLOW } from "./architecture-workflow.ts";
import { ISSUE_WORKFLOW } from "./issue-workflow.ts";
import { PR_FEEDBACK_WORKFLOW } from "./pr-feedback-workflow.ts";
import { PR_REVIEW_WORKFLOW } from "./pr-review-workflow.ts";
import { PRD_IMPLEMENT_WORKFLOW } from "./prd-implement-workflow.ts";
import { PRD_SPLIT_WORKFLOW } from "./prd-split-workflow.ts";
import { QUEUE_WORKFLOW } from "./queue-workflow.ts";
import { REMOTE_WORKFLOW } from "./remote-workflow.ts";
import { UPDATE_BRANCH_WORKFLOW } from "./update-branch-workflow.ts";

export type InitResult = {
  created: string[];
  skipped: string[];
  updated: string[];
};

type Template = {
  path: string;
  content: string;
};

const TEMPLATES: Template[] = [
  { path: ".github/workflows/ralphworks-issue.yml", content: ISSUE_WORKFLOW },
  { path: ".github/workflows/ralphworks-prd-split.yml", content: PRD_SPLIT_WORKFLOW },
  { path: ".github/workflows/ralphworks-prd-implement.yml", content: PRD_IMPLEMENT_WORKFLOW },
  { path: ".github/workflows/ralphworks-queue.yml", content: QUEUE_WORKFLOW },
  { path: ".github/workflows/ralphworks-pr-review.yml", content: PR_REVIEW_WORKFLOW },
  { path: ".github/workflows/ralphworks-pr-feedback.yml", content: PR_FEEDBACK_WORKFLOW },
  { path: ".github/workflows/ralphworks-update-branch.yml", content: UPDATE_BRANCH_WORKFLOW },
  { path: ".github/workflows/ralphworks-architecture.yml", content: ARCHITECTURE_WORKFLOW },
  { path: ".github/workflows/ralphworks.yml", content: REMOTE_WORKFLOW },
];

export async function initProject(cwd = process.cwd()): Promise<InitResult> {
  const result: InitResult = { created: [], skipped: [], updated: [] };

  for (const template of TEMPLATES) {
    const absolutePath = join(cwd, template.path);
    await mkdir(dirname(absolutePath), { recursive: true });
    try {
      await writeFile(absolutePath, template.content, { encoding: "utf8", flag: "wx" });
      result.created.push(template.path);
    } catch (error) {
      if (isAlreadyExists(error)) {
        result.skipped.push(template.path);
        continue;
      }
      throw error;
    }
  }

  const ignorePath = join(cwd, ".gitignore");
  let ignoreText: string;
  try {
    ignoreText = await readFile(ignorePath, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await writeFile(ignorePath, ".ralph/\n", { encoding: "utf8", flag: "wx" });
    result.created.push(".gitignore");
    return result;
  }
  if (!/^\/?\.ralph\/?$/m.test(ignoreText)) {
    await writeFile(ignorePath, `${ignoreText}${ignoreText && !ignoreText.endsWith("\n") ? "\n" : ""}.ralph/\n`, "utf8");
    result.updated.push(".gitignore");
  }

  return result;
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
