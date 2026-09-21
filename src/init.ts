import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
  {
    path: ".github/workflows/ralphworks.yml",
    content: [
      "name: RalphWorks",
      "",
      "on:",
      "  workflow_dispatch:",
      "    inputs:",
      "      task:",
      "        description: RalphWorks task file",
      "        required: true",
      "        default: ralphworks.yaml",
      "      request_id:",
      "        description: Dispatch correlation ID",
      "        required: false",
      "",
      "run-name: RalphWorks ${{ inputs.request_id }}",
      "",
      "jobs:",
      "  ralph:",
      "    runs-on: ubuntu-latest",
      "    permissions:",
      "      contents: read",
      "    env:",
      "      RALPH_TASK: ${{ inputs.task }}",
      "      RALPHWORKS_MODEL: ${{ vars.RALPHWORKS_MODEL }}",
      "      RALPHWORKS_REF: ${{ vars.RALPHWORKS_REF }}",
      "      RALPHWORKS_SOURCE_REPO: ${{ vars.RALPHWORKS_SOURCE_REPO || 'OctopusGarage/ralphworks' }}",
      "      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}",
      "      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}",
      "      NVIDIA_API_KEY: ${{ secrets.NVIDIA_API_KEY }}",
      "      ZAI_CODING_CN_API_KEY: ${{ secrets.ZAI_CODING_CN_API_KEY }}",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "        with:",
      "          fetch-depth: 0",
      "      - uses: pnpm/action-setup@v4",
      "        with:",
      "          version: 10.13.1",
      "      - uses: actions/setup-node@v4",
      "        with:",
      "          node-version: 24",
      "      - name: Checkout RalphWorks",
      "        env:",
      "          GH_TOKEN: ${{ secrets.RALPHWORKS_REPO_TOKEN }}",
      "        run: |",
      '          [[ "$RALPHWORKS_SOURCE_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "Invalid RALPHWORKS_SOURCE_REPO" >&2; exit 1; }',
      '          if [ -n "$GH_TOKEN" ]; then gh repo clone "$RALPHWORKS_SOURCE_REPO" "$RUNNER_TEMP/ralphworks"',
      '          else git clone "https://github.com/${RALPHWORKS_SOURCE_REPO}.git" "$RUNNER_TEMP/ralphworks"; fi',
      '          if [ -n "$RALPHWORKS_REF" ]; then git -C "$RUNNER_TEMP/ralphworks" checkout --detach "$RALPHWORKS_REF"; fi',
      '          echo "RalphWorks commit: $(git -C "$RUNNER_TEMP/ralphworks" rev-parse HEAD)"',
      "      - name: Build RalphWorks",
      '        run: pnpm --dir "$RUNNER_TEMP/ralphworks" install --frozen-lockfile && pnpm --dir "$RUNNER_TEMP/ralphworks" build',
      "      - run: |",
      "          if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile",
      "          elif [ -f package-lock.json ]; then npm ci",
      "          elif [ -f yarn.lock ]; then yarn install --frozen-lockfile",
      "          fi",
      '      - run: echo "RALPH_BASE=$(git rev-parse HEAD)" >> "$GITHUB_ENV"',
      "      - run: |",
      "          git config user.name 'ralphworks[bot]'",
      "          git config user.email '41898282+github-actions[bot]@users.noreply.github.com'",
      "      - name: Prepare optional Pi model config",
      "        run: |",
      "          if [ -f .ralphworks/models.json ]; then",
      "            mkdir -p ~/.pi/agent",
      "            cp .ralphworks/models.json ~/.pi/agent/models.json",
      "          fi",
      "      - name: Run RalphWorks",
      "        env:",
      "          RALPHWORKS_AUTH_SECRET_NAME: ${{ vars.RALPHWORKS_AUTH_SECRET }}",
      "          RALPHWORKS_AUTH_SECRET_VALUE: ${{ secrets[vars.RALPHWORKS_AUTH_SECRET] }}",
      "        run: |",
      '          if [ -n "$RALPHWORKS_AUTH_SECRET_NAME" ]; then',
      '            [[ "$RALPHWORKS_AUTH_SECRET_NAME" =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "Invalid RALPHWORKS_AUTH_SECRET name" >&2; exit 1; }',
      '            [ -n "$RALPHWORKS_AUTH_SECRET_VALUE" ] || { echo "Configured provider secret is empty" >&2; exit 1; }',
      '            export "$RALPHWORKS_AUTH_SECRET_NAME=$RALPHWORKS_AUTH_SECRET_VALUE"',
      "          fi",
      '          node "$RUNNER_TEMP/ralphworks/dist/cli.js" run "$RALPH_TASK" --executor host',
      "      - name: Export inspectable patch",
      "        if: always()",
      "        run: |",
      "          mkdir -p .ralph/export",
      '          git -C "$RUNNER_TEMP/ralphworks" rev-parse HEAD > .ralph/export/ralphworks-commit.txt',
      "          git add -N --all",
      '          git diff --binary "${RALPH_BASE:-HEAD}" -- . ":!.ralph" > .ralph/export/change.patch',
      "      - uses: actions/upload-artifact@v4",
      "        if: always()",
      "        with:",
      "          name: ralphworks-result",
      "          path: |",
      "            .ralph/export/change.patch",
      "            .ralph/export/ralphworks-commit.txt",
      "            .ralph/runs/",
      "            .ralph/progress/",
      "",
    ].join("\n"),
  },
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
