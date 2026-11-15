import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { log, openDb, seedCategories } from "./db.ts";
import { Engine } from "./engine.ts";
import { ConfiguredShopee, ConfiguredWriter, IntegrationStore } from "./integrations.ts";
import type { WhatsAppProvider } from "./whatsapp.ts";
import { BaileysProvider, EvolutionProvider } from "./whatsapp.ts";

const config = loadConfig();
const db = openDb(join(config.DATA_DIR, "radar.db"));
seedCategories(db);

const integrations = new IntegrationStore(
  db,
  config.APP_SECRET,
  {
    shopee_app_id: config.SHOPEE_APP_ID,
    shopee_secret: config.SHOPEE_SECRET,
    nvidia_api_key: config.NVIDIA_API_KEY,
    nvidia_model: config.NVIDIA_MODEL,
    anthropic_api_key: config.ANTHROPIC_API_KEY,
    anthropic_model: config.ANTHROPIC_MODEL,
  },
  config.NVIDIA_ENDPOINT,
);
const shopee = new ConfiguredShopee(integrations, config.SHOPEE_ENDPOINT);
const writer = new ConfiguredWriter(integrations);

function createProvider(): WhatsAppProvider {
  if (config.WHATSAPP_PROVIDER === "baileys") return new BaileysProvider(config.DATA_DIR);
  if (!config.EVOLUTION_URL || !config.EVOLUTION_API_KEY || !config.EVOLUTION_INSTANCE) {
    throw new Error("Preencha EVOLUTION_URL, EVOLUTION_API_KEY e EVOLUTION_INSTANCE no .env");
  }
  return new EvolutionProvider({ url: config.EVOLUTION_URL, apiKey: config.EVOLUTION_API_KEY, instance: config.EVOLUTION_INSTANCE });
}

const whatsapp = createProvider();
const engine = new Engine({ db, shopee, writer, whatsapp, secret: config.APP_SECRET });
const app = await buildApp({ db, config, engine, shopee, writer, whatsapp, integrations });

function every(ms: number, name: string, task: () => Promise<unknown>): NodeJS.Timeout {
  return setInterval(() => {
    task().catch((error: Error) => log(db, "error", `${name}: ${error.message}`));
  }, ms);
}

const timers = [
  every(5_000, "Fila", () => engine.tick()),
  every(10 * 60_000, "Garimpo", () => engine.collect()),
  every(60 * 60_000, "Vendas", () => engine.syncConversions()),
];

if (config.WHATSAPP_PROVIDER === "evolution" || existsSync(join(config.DATA_DIR, "wa-auth", "creds.json"))) {
  whatsapp.start().catch((error: Error) => log(db, "error", `WhatsApp: ${error.message}`));
}

async function shutdown(): Promise<void> {
  timers.forEach(clearInterval);
  await whatsapp.stop();
  await app.close();
  db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await app.listen({ host: config.HOST, port: config.PORT });
console.log(`Radar Magnata no ar: http://${config.HOST === "0.0.0.0" ? "localhost" : config.HOST}:${config.PORT}`);
