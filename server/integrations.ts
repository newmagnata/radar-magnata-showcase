import { decrypt, encrypt } from "./auth.ts";
import type { Db } from "./db.ts";
import type { ConversionItem, SearchInput, ShopeeApi, ShopeeProduct } from "./shopee.ts";
import { ShopeeClient } from "./shopee.ts";
import type { HeadlineWriter, OfferCopy } from "./writer.ts";
import { ClaudeWriter, NvidiaWriter } from "./writer.ts";

export const INTEGRATION_KEYS = [
  "shopee_app_id",
  "shopee_secret",
  "ai_provider",
  "nvidia_api_key",
  "nvidia_model",
  "anthropic_api_key",
  "anthropic_model",
] as const;

export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];

interface Field {
  key: IntegrationKey;
  label: string;
  secret: boolean;
  hint?: string;
  options?: { value: string; label: string }[];
}

interface Section {
  id: string;
  name: string;
  help: string;
  testable: boolean;
  fields: Field[];
}

export const AI_PROVIDERS = ["auto", "nvidia", "anthropic"];

const SECTIONS: Section[] = [
  {
    id: "shopee",
    name: "Shopee",
    help: "Painel de afiliados da Shopee, em Open API.",
    testable: true,
    fields: [
      { key: "shopee_app_id", label: "App ID", secret: true },
      { key: "shopee_secret", label: "Secret", secret: true },
    ],
  },
  {
    id: "ai",
    name: "Qual IA usar",
    help: "Escreve a chamada e o nome curto do produto.",
    testable: false,
    fields: [
      {
        key: "ai_provider",
        label: "Provedor",
        secret: false,
        options: [
          { value: "auto", label: "Automático (a que tiver chave)" },
          { value: "nvidia", label: "NVIDIA" },
          { value: "anthropic", label: "Claude (Anthropic)" },
        ],
      },
    ],
  },
  {
    id: "nvidia",
    name: "NVIDIA",
    help: "Chave gerada em build.nvidia.com.",
    testable: true,
    fields: [
      { key: "nvidia_api_key", label: "Chave da API", secret: true },
      { key: "nvidia_model", label: "Modelo", secret: false, hint: "Nome exato do modelo na NVIDIA" },
    ],
  },
  {
    id: "anthropic",
    name: "Claude (Anthropic)",
    help: "Chave gerada em console.anthropic.com. Cobrada por uso.",
    testable: true,
    fields: [
      { key: "anthropic_api_key", label: "Chave da API", secret: true },
      { key: "anthropic_model", label: "Modelo", secret: false },
    ],
  },
];

export class IntegrationStore {
  private readonly db: Db;
  private readonly secret: string;
  private readonly fallback: Partial<Record<IntegrationKey, string | undefined>>;
  private readonly nvidiaEndpoint: string;
  private readonly cache = new Map<IntegrationKey, string | null>();

  constructor(db: Db, secret: string, fallback: Partial<Record<IntegrationKey, string | undefined>> = {}, nvidiaEndpoint = "https://integrate.api.nvidia.com/v1") {
    this.db = db;
    this.secret = secret;
    this.fallback = fallback;
    this.nvidiaEndpoint = nvidiaEndpoint;
  }

  private stored(key: IntegrationKey): string | null {
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(`integration:${key}`) as { value: string } | undefined;
    const value = row ? decrypt(row.value, this.secret) : null;
    this.cache.set(key, value);
    return value;
  }

  get(key: IntegrationKey): string | undefined {
    return this.stored(key) ?? this.fallback[key];
  }

  /** Valor vazio ou nulo apaga o que foi salvo no painel. */
  set(key: IntegrationKey, value: string | null): void {
    if (value) {
      this.db
        .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(`integration:${key}`, encrypt(value, this.secret));
    } else {
      this.db.prepare("DELETE FROM settings WHERE key = ?").run(`integration:${key}`);
    }
    this.cache.delete(key);
  }

  /** Nunca devolve o valor de um campo secreto: só se existe e os últimos caracteres. */
  describe() {
    return SECTIONS.map((section) => ({
      ...section,
      fields: section.fields.map((field) => {
        const value = this.get(field.key);
        return {
          key: field.key,
          label: field.label,
          secret: field.secret,
          hint: field.hint,
          options: field.options,
          configured: Boolean(value),
          value: field.secret ? null : value ?? "",
          ending: field.secret && value && value.length >= 12 ? value.slice(-4) : null,
          source: this.stored(field.key) ? "painel" : value ? "arquivo" : null,
        };
      }),
    }));
  }

  writerFor(provider: "nvidia" | "anthropic"): HeadlineWriter | null {
    if (provider === "nvidia") {
      const key = this.get("nvidia_api_key");
      return key ? new NvidiaWriter(key, this.get("nvidia_model") ?? "nvidia/nemotron-3-ultra-550b-a55b", this.nvidiaEndpoint) : null;
    }
    const key = this.get("anthropic_api_key");
    return key ? new ClaudeWriter(key, this.get("anthropic_model") ?? "claude-opus-5-5") : null;
  }
}

/** Lê as chaves a cada uso, para valerem sem reiniciar o sistema. */
export class ConfiguredShopee implements ShopeeApi {
  private readonly store: IntegrationStore;
  private readonly endpoint: string;

  constructor(store: IntegrationStore, endpoint: string) {
    this.store = store;
    this.endpoint = endpoint;
  }

  private client(): ShopeeClient {
    return new ShopeeClient({ appId: this.store.get("shopee_app_id"), secret: this.store.get("shopee_secret"), endpoint: this.endpoint });
  }

  configured(): boolean {
    return this.client().configured();
  }

  search(input: SearchInput): Promise<ShopeeProduct[]> {
    return this.client().search(input);
  }

  shortLink(originUrl: string, subIds: string[]): Promise<string> {
    return this.client().shortLink(originUrl, subIds);
  }

  conversions(startSeconds: number, endSeconds: number): Promise<ConversionItem[]> {
    return this.client().conversions(startSeconds, endSeconds);
  }
}

export class ConfiguredWriter implements HeadlineWriter {
  private readonly store: IntegrationStore;

  constructor(store: IntegrationStore) {
    this.store = store;
  }

  private current(): HeadlineWriter | null {
    const choice = this.store.get("ai_provider") ?? "auto";
    if (choice === "nvidia" || choice === "anthropic") return this.store.writerFor(choice);
    return this.store.writerFor("anthropic") ?? this.store.writerFor("nvidia");
  }

  configured(): boolean {
    return this.current() !== null;
  }

  async headline(product: ShopeeProduct): Promise<OfferCopy | null> {
    return (await this.current()?.headline(product)) ?? null;
  }
}
