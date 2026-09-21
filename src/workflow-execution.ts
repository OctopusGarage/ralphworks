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
