// Shared steps for running RalphWorks inside generated scenario workflows.
export const PROVIDER_CREDENTIAL_ENV = [
  "          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}",
  "          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}",
  "          NVIDIA_API_KEY: ${{ secrets.NVIDIA_API_KEY }}",
  "          ZAI_CODING_CN_API_KEY: ${{ secrets.ZAI_CODING_CN_API_KEY }}",
  "          RALPHWORKS_AUTH_SECRET_NAME: ${{ vars.RALPHWORKS_AUTH_SECRET }}",
  "          RALPHWORKS_AUTH_SECRET_VALUE: ${{ secrets[vars.RALPHWORKS_AUTH_SECRET] }}",
] as const;

export const RALPHWORKS_CHECKOUT_AND_BUILD = [
  '          if [ -n "$SOURCE_TOKEN" ]; then GH_TOKEN="$SOURCE_TOKEN" gh repo clone "$RALPHWORKS_SOURCE_REPO" "$RUNNER_TEMP/ralphworks"',
  '          else git clone "https://github.com/${RALPHWORKS_SOURCE_REPO}.git" "$RUNNER_TEMP/ralphworks"; fi',
  '          git -C "$RUNNER_TEMP/ralphworks" checkout --detach "$RALPHWORKS_REF"',
  '          pnpm --dir "$RUNNER_TEMP/ralphworks" install --frozen-lockfile',
  '          pnpm --dir "$RUNNER_TEMP/ralphworks" build',
] as const;

export function checkedPatchArtifact(artifact: string): string[] {
  const root = `$RUNNER_TEMP/${artifact}`;
  return [
    `          result=$(find "${root}/runs" -name result.json -type f -print -quit)`,
    '          [ -n "$result" ] || { echo "Missing RalphWorks result" >&2; exit 1; }',
    '          jq -e \'.status == "completed" and (.iterations as $last | [.checks[] | select(.iteration == $last)] | length > 0) and (.iterations as $last | [.checks[] | select(.iteration == $last and .exitCode != 0)] | length == 0)\' "$result" >/dev/null',
    `          [ -s "${root}/export/change.patch" ] || { echo "Completed task produced no patch" >&2; exit 1; }`,
    `          [ -s "${root}/export/base-sha.txt" ] || { echo "Missing patch base commit" >&2; exit 1; }`,
  ];
}

export function failureComment(
  artifact: string,
  targetNumber: string,
  triggerLabel: string,
  fallback: string,
  target: "issue" | "pr" = "issue",
): string[] {
  const actionsToken = "${{ github.token }}";
  return [
    `          GH_TOKEN="${actionsToken}" gh run download "$GITHUB_RUN_ID" --name '${artifact}' --dir "$RUNNER_TEMP/ralph-feedback" >/dev/null 2>&1 || true`,
    '          result=$(find "$RUNNER_TEMP/ralph-feedback/runs" -name result.json -type f -print -quit 2>/dev/null || true)',
    '          if [ -n "$result" ] && jq -e \'.status == "needs_input"\' "$result" >/dev/null; then',
    `            printf 'RalphWorks needs human input:\\n\\n%s\\n\\nUpdate this ${target.toUpperCase()} and re-add ${triggerLabel} to retry. [Run and artifacts](%s).\\n' "$(jq -r '.reason // .lastSummary // "See run artifacts"' "$result")" "$RUN_URL" > "$RUNNER_TEMP/ralph-feedback.md"`,
    "          else",
    `            printf '%s [Run and artifacts](%s).\\n' '${fallback}' "$RUN_URL" > "$RUNNER_TEMP/ralph-feedback.md"`,
    "          fi",
    `          gh ${target} comment "$${targetNumber}" --body-file "$RUNNER_TEMP/ralph-feedback.md"`,
  ];
}
