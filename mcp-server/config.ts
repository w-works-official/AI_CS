export type RuntimeEnvironment = "development" | "production";

export type EnvironmentTarget = {
  name: RuntimeEnvironment;
  appsScriptUrl: string;
  appsScriptKey: string;
};

export type ServerConfig = {
  publicOrigin: string;
  resourceUrl: string;
  oauthIssuer: string;
  oauthJwksUrl: string;
  oauthAudience: string;
  allowedOrigins: Set<string>;
  productionEnabled: boolean;
  subjectEnvironment: Map<string, RuntimeEnvironment>;
  targets: Record<RuntimeEnvironment, EnvironmentTarget>;
};

function csv(value: string | undefined): string[] {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = String(env[key] ?? "").trim();
  if (!value) throw new Error(`SERVER_CONFIG_MISSING:${key}`);
  return value;
}

function absoluteHttpsUrl(value: string, key: string, allowLocalhost = false, preserveTrailingSlash = false): string {
  let url: URL;
  const hadTrailingSlash = String(value).trim().endsWith("/");
  try {
    url = new URL(value);
  } catch {
    throw new Error(`SERVER_CONFIG_INVALID_URL:${key}`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(allowLocalhost && local)) {
    throw new Error(`SERVER_CONFIG_HTTPS_REQUIRED:${key}`);
  }
  url.hash = "";
  const normalized = url.toString();
  if (!preserveTrailingSlash) return normalized.replace(/\/$/, "");
  if (!hadTrailingSlash && url.pathname === "/" && !url.search) return normalized.replace(/\/$/, "");
  return normalized;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const publicOrigin = absoluteHttpsUrl(required(env, "AI_CS_PUBLIC_ORIGIN"), "AI_CS_PUBLIC_ORIGIN", env.NODE_ENV !== "production");
  const resourceUrl = absoluteHttpsUrl(env.AI_CS_RESOURCE_URL || `${publicOrigin}/mcp`, "AI_CS_RESOURCE_URL", env.NODE_ENV !== "production");
  const oauthIssuer = absoluteHttpsUrl(required(env, "AI_CS_OAUTH_ISSUER"), "AI_CS_OAUTH_ISSUER", env.NODE_ENV !== "production", true);
  const oauthJwksUrl = absoluteHttpsUrl(required(env, "AI_CS_OAUTH_JWKS_URL"), "AI_CS_OAUTH_JWKS_URL", env.NODE_ENV !== "production");
  const oauthAudience = required(env, "AI_CS_OAUTH_AUDIENCE");
  const developmentSubjects = csv(env.AI_CS_DEV_ALLOWED_SUBJECTS);
  const productionSubjects = csv(env.AI_CS_PROD_ALLOWED_SUBJECTS);
  if (!developmentSubjects.length) throw new Error("SERVER_CONFIG_MISSING:AI_CS_DEV_ALLOWED_SUBJECTS");

  const overlap = developmentSubjects.filter((subject) => productionSubjects.includes(subject));
  if (overlap.length) throw new Error("SERVER_CONFIG_SUBJECT_ENVIRONMENT_OVERLAP");

  const subjectEnvironment = new Map<string, RuntimeEnvironment>();
  developmentSubjects.forEach((subject) => subjectEnvironment.set(subject, "development"));
  productionSubjects.forEach((subject) => subjectEnvironment.set(subject, "production"));

  const productionEnabled = env.AI_CS_PRODUCTION_ENABLED === "true";
  const targets: Record<RuntimeEnvironment, EnvironmentTarget> = {
    development: {
      name: "development",
      appsScriptUrl: absoluteHttpsUrl(required(env, "AI_CS_DEV_APPS_SCRIPT_URL"), "AI_CS_DEV_APPS_SCRIPT_URL"),
      appsScriptKey: required(env, "AI_CS_DEV_APPS_SCRIPT_KEY"),
    },
    production: {
      name: "production",
      appsScriptUrl: productionEnabled
        ? absoluteHttpsUrl(required(env, "AI_CS_PROD_APPS_SCRIPT_URL"), "AI_CS_PROD_APPS_SCRIPT_URL")
        : "",
      appsScriptKey: productionEnabled ? required(env, "AI_CS_PROD_APPS_SCRIPT_KEY") : "",
    },
  };

  const allowedOrigins = new Set([
    publicOrigin,
    "https://chatgpt.com",
    "https://chat.openai.com",
    ...csv(env.AI_CS_ALLOWED_ORIGINS),
  ]);
  if (env.NODE_ENV !== "production") {
    allowedOrigins.add("http://localhost:3000");
    allowedOrigins.add("http://127.0.0.1:3000");
  }

  return {
    publicOrigin,
    resourceUrl,
    oauthIssuer,
    oauthJwksUrl,
    oauthAudience,
    allowedOrigins,
    productionEnabled,
    subjectEnvironment,
    targets,
  };
}

export function targetForSubject(config: ServerConfig, subject: string): EnvironmentTarget {
  const environment = config.subjectEnvironment.get(subject);
  if (!environment) throw new Error("ACCOUNT_NOT_AUTHORIZED");
  if (environment === "production" && !config.productionEnabled) throw new Error("PRODUCTION_DISABLED");
  return config.targets[environment];
}
