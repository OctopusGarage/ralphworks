const SENSITIVE_NAME = /(?:_API_KEY|_TOKEN|_SECRET|^API_KEY$|^GH_TOKEN$)$/;

export function redactSensitiveValues(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let redacted = text;
  for (const [name, value] of Object.entries(env)) {
    if (!SENSITIVE_NAME.test(name) || !value || value.length < 8) continue;
    redacted = redacted.split(value).join("[REDACTED]");
    redacted = redacted.split(JSON.stringify(value).slice(1, -1)).join("[REDACTED]");
  }
  return redacted;
}
