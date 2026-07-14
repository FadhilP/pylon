const ALLOWED_ENV = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "SHELL", "LANG", "TERM",
  "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "PI_CODING_AGENT_DIR", "PI_PACKAGE_DIR", "PI_OFFLINE", "PI_TELEMETRY",
  "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANT_LING_API_KEY", "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_RESOURCE_NAME", "AZURE_OPENAI_API_VERSION", "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
  "DEEPSEEK_API_KEY", "NVIDIA_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY",
  "FIREWORKS_API_KEY", "TOGETHER_API_KEY", "OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY", "ZAI_API_KEY", "ZAI_CODING_CN_API_KEY",
  "MISTRAL_API_KEY", "MINIMAX_API_KEY", "MOONSHOT_API_KEY", "OPENCODE_API_KEY", "KIMI_API_KEY",
  "XIAOMI_API_KEY", "XIAOMI_TOKEN_PLAN_CN_API_KEY", "XIAOMI_TOKEN_PLAN_AMS_API_KEY", "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID",
  "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION",
]);

const PROVIDER_ENV = new Set([...ALLOWED_ENV].filter((key) => /(?:API_KEY|OAUTH_TOKEN|AWS_|AZURE_|CLOUDFLARE_|ACCOUNT_ID|GATEWAY_ID|RESOURCE_NAME|DEPLOYMENT_NAME)/.test(key)));

function selectedProviderEnv(provider: string): Set<string> {
  const name = provider.toLowerCase();
  const selected = new Set<string>();
  const include = (...keys: string[]) => keys.forEach((key) => selected.add(key));
  if (name.includes("anthropic")) include("ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN");
  if (name.includes("openai") && !name.includes("azure")) include("OPENAI_API_KEY");
  if (name.includes("azure")) include("AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_RESOURCE_NAME", "AZURE_OPENAI_API_VERSION", "AZURE_OPENAI_DEPLOYMENT_NAME_MAP");
  if (name.includes("google") || name.includes("gemini")) include("GEMINI_API_KEY");
  const direct: Array<[string, string[]]> = [
    ["deepseek", ["DEEPSEEK_API_KEY"]], ["nvidia", ["NVIDIA_API_KEY"]], ["groq", ["GROQ_API_KEY"]],
    ["cerebras", ["CEREBRAS_API_KEY"]], ["xai", ["XAI_API_KEY"]], ["fireworks", ["FIREWORKS_API_KEY"]],
    ["together", ["TOGETHER_API_KEY"]], ["openrouter", ["OPENROUTER_API_KEY"]], ["mistral", ["MISTRAL_API_KEY"]],
    ["minimax", ["MINIMAX_API_KEY"]], ["moonshot", ["MOONSHOT_API_KEY"]], ["opencode", ["OPENCODE_API_KEY"]],
    ["kimi", ["KIMI_API_KEY"]], ["cloudflare", ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"]],
  ];
  for (const [needle, keys] of direct) if (name.includes(needle)) include(...keys);
  if (name.includes("bedrock") || name.includes("amazon")) include("AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION");
  if (name.includes("gateway")) include("AI_GATEWAY_API_KEY");
  if (name.includes("zai")) include("ZAI_API_KEY", "ZAI_CODING_CN_API_KEY");
  if (name.includes("xiaomi")) include("XIAOMI_API_KEY", "XIAOMI_TOKEN_PLAN_CN_API_KEY", "XIAOMI_TOKEN_PLAN_AMS_API_KEY", "XIAOMI_TOKEN_PLAN_SGP_API_KEY");
  return selected;
}

export function scoutChildEnv(extra: NodeJS.ProcessEnv = {}, source: NodeJS.ProcessEnv = process.env, provider?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const providerEnv = provider ? selectedProviderEnv(provider) : undefined;
  for (const [key, value] of Object.entries(source)) {
    const normalized = key.toUpperCase();
    if (value !== undefined && (ALLOWED_ENV.has(normalized) || normalized.startsWith("LC_")) && (!providerEnv || !PROVIDER_ENV.has(normalized) || providerEnv.has(normalized))) env[key] = value;
  }
  return { ...env, ...extra };
}
