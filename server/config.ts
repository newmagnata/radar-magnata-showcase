import { z } from "zod";

const flag = z.enum(["true", "false"]).default("false").transform((v) => v === "true");
const optional = z.string().trim().optional().transform((v) => v || undefined);

const schema = z.object({
  APP_SECRET: z.string().min(32, "APP_SECRET precisa ter 32 caracteres ou mais. Rode: npm run setup"),
  SETUP_TOKEN: z.string().min(16, "SETUP_TOKEN ausente. Rode: npm run setup"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().default(3000),
  DATA_DIR: z.string().default("data"),
  COOKIE_SECURE: flag,
  SHOPEE_APP_ID: optional,
  SHOPEE_SECRET: optional,
  SHOPEE_ENDPOINT: z.string().url().default("https://open-api.affiliate.shopee.com.br/graphql"),
  ANTHROPIC_API_KEY: optional,
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  NVIDIA_API_KEY: optional,
  NVIDIA_MODEL: z.string().default("nvidia/nemotron-3-ultra-550b-a55b"),
  NVIDIA_ENDPOINT: z.string().url().default("https://integrate.api.nvidia.com/v1"),
  WHATSAPP_PROVIDER: z.enum(["baileys", "evolution"]).default("baileys"),
  EVOLUTION_URL: optional,
  EVOLUTION_API_KEY: optional,
  EVOLUTION_INSTANCE: optional,
  EVOLUTION_WEBHOOK_SECRET: optional,
});

export type Config = z.output<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${String(i.path[0])}: ${i.message}`).join("\n"));
  }
  return parsed.data;
}
