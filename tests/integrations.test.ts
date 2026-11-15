import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../server/db.ts";
import { ConfiguredShopee, ConfiguredWriter, IntegrationStore } from "../server/integrations.ts";
import { allowedImage, ShopeeClient, ShopeeError } from "../server/shopee.ts";
import { EvolutionProvider } from "../server/whatsapp.ts";
import { NvidiaWriter } from "../server/writer.ts";

let server: Server | undefined;

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: string;
}

function serve(respond: (seen: Seen, res: ServerResponse) => void): Promise<string> {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => respond({ method: req.method, url: req.url, headers: req.headers, body }, res));
  });
  return new Promise((resolve) => {
    server!.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`));
  });
}

afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

const json = (res: ServerResponse, value: unknown) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(value));
};

describe("cliente Shopee (contra servidor local de teste)", () => {
  it("assina a requisição e converte os produtos", async () => {
    let seen: Seen | undefined;
    const endpoint = await serve((request, res) => {
      seen = request;
      json(res, {
        data: {
          productOfferV2: {
            nodes: [{ itemId: 7, productName: "Panela", commissionRate: "0.08", priceMin: "39.90", priceDiscountRate: 25, ratingStar: "4.7", sales: 10, imageUrl: "https://cf.shopee.com.br/file/a", productLink: "https://shopee.com.br/p", shopName: "L" }],
          },
        },
      });
    });
    const client = new ShopeeClient({ appId: "123", secret: "abc", endpoint });
    const [product] = await client.search({ keyword: 'pa"nela', sortType: 2, limit: 5 });
    expect(product).toMatchObject({ itemId: "7", price: 39.9, commissionRate: 8, discountRate: 25, rating: 4.7 });

    const header = String(seen?.headers.authorization);
    const timestamp = header.match(/Timestamp=(\d+)/)?.[1];
    const expected = createHash("sha256").update(`123${timestamp}${seen?.body}abc`).digest("hex");
    expect(header).toContain(`Signature=${expected}`);
    expect(header).toMatch(/^SHA256 Credential=123,/);
    expect(JSON.parse(seen!.body).query).toContain('keyword: "pa\\"nela"');
  });

  it("percorre todas as páginas do relatório de vendas", async () => {
    let calls = 0;
    const endpoint = await serve((_request, res) => {
      calls += 1;
      json(res, {
        data: {
          conversionReport: {
            nodes: [{ conversionId: calls, purchaseTime: 100, utmContent: "a-b", orders: [{ orderId: 1, orderStatus: calls === 1 ? "CANCELLED" : "COMPLETED", items: [{ itemId: 2, itemName: "X", actualAmount: "10", itemTotalCommission: "1" }] }] }],
            pageInfo: { hasNextPage: calls === 1, scrollId: "s" },
          },
        },
      });
    });
    const items = await new ShopeeClient({ appId: "1", secret: "2", endpoint }).conversions(0, 100);
    expect(items.map((i) => i.status)).toEqual(["canceled", "validated"]);
  });

  it("transforma erros da Shopee em mensagem clara", async () => {
    const endpoint = await serve((_request, res) => json(res, { errors: [{ message: "Invalid signature" }] }));
    await expect(new ShopeeClient({ appId: "1", secret: "2", endpoint }).search({ keyword: "x", sortType: 2, limit: 1 })).rejects.toThrow(ShopeeError);
  });

  it("repete quando a Shopee devolve System Error", async () => {
    let calls = 0;
    const endpoint = await serve((_request, res) => {
      calls += 1;
      if (calls < 3) return json(res, { errors: [{ message: "error [10000]: System Error" }] });
      json(res, { data: { generateShortLink: { shortLink: "https://s/1" } } });
    });
    expect(await new ShopeeClient({ appId: "1", secret: "2", endpoint, retryMs: 1 }).shortLink("a", [])).toBe("https://s/1");
    expect(calls).toBe(3);
  });

  it("não chama a Shopee sem chaves", async () => {
    await expect(new ShopeeClient({ endpoint: "http://127.0.0.1:1" }).shortLink("a", [])).rejects.toThrow("não configuradas");
  });

  it("só aceita imagens dos domínios da Shopee", () => {
    expect(allowedImage("https://down-br.img.susercontent.com/file/x")).toBe(true);
    expect(allowedImage("http://down-br.img.susercontent.com/file/x")).toBe(false);
    expect(allowedImage("https://susercontent.com.evil.net/x")).toBe(false);
    expect(allowedImage("https://169.254.169.254/latest")).toBe(false);
    expect(allowedImage("isto não é url")).toBe(false);
  });
});

describe("redator NVIDIA (contra servidor local de teste)", () => {
  const item = { itemId: "1", name: "Panela", imageUrl: "", productLink: "", price: 10, discountRate: 0, commissionRate: 5, rating: 4.5, sales: 9, shopName: "L", officialStore: false };

  it("envia a chave e limpa o raciocínio e os links da resposta", async () => {
    let seen: Seen | undefined;
    const endpoint = await serve((request, res) => {
      seen = request;
      json(res, { choices: [{ finish_reason: "stop", message: { content: "<think>pensando</think>Sua cozinha merece https://x.com" } }] });
    });
    expect(await new NvidiaWriter("nvapi-teste", "modelo/x", `${endpoint}/`).headline(item)).toEqual({ headline: "Sua cozinha merece", title: null });
    expect(seen?.url).toBe("/chat/completions");
    expect(seen?.headers.authorization).toBe("Bearer nvapi-teste");
    expect(JSON.parse(seen!.body).model).toBe("modelo/x");
  });

  it("usa o modelo reserva quando o principal cai, mas não quando a chave é recusada", async () => {
    const models: string[] = [];
    let status = 400;
    const endpoint = await serve((request, res) => {
      const { model } = JSON.parse(request.body) as { model: string };
      models.push(model);
      if (model === "principal") {
        res.statusCode = status;
        return json(res, {});
      }
      json(res, { choices: [{ finish_reason: "stop", message: { content: "Frase do reserva" } }] });
    });
    expect(await new NvidiaWriter("k", "principal", endpoint, "reserva").headline(item)).toEqual({ headline: "Frase do reserva", title: null });
    expect(models).toEqual(["principal", "reserva"]);
    status = 401;
    await expect(new NvidiaWriter("k", "principal", endpoint, "reserva").headline(item)).rejects.toThrow("recusou a chave");
    expect(models).toHaveLength(3);
  });

  it("ignora resposta cortada e informa erro da API", async () => {
    const endpoint = await serve((request, res) => {
      if (JSON.parse(request.body).model === "falha") {
        res.statusCode = 429;
        return json(res, {});
      }
      json(res, { choices: [{ finish_reason: "length", message: { content: "Frase cor" } }] });
    });
    expect(await new NvidiaWriter("k", "ok", endpoint, null).headline(item)).toBeNull();
    await expect(new NvidiaWriter("k", "falha", endpoint, null).headline(item)).rejects.toThrow("429");
  });
});

describe("conector Evolution (contra servidor local de teste)", () => {
  it("envia imagem com a chave e interpreta o webhook", async () => {
    const calls: Seen[] = [];
    const url = await serve((request, res) => {
      calls.push(request);
      json(res, { instance: { state: "open" } });
    });
    const provider = new EvolutionProvider({ url, apiKey: "chave", instance: "radar" });
    await provider.refresh();
    expect(provider.status().state).toBe("open");

    await provider.sendImage("1@g.us", "https://x/y.jpg", "legenda");
    const send = calls.at(-1)!;
    expect(send.url).toBe("/message/sendMedia/radar");
    expect(send.headers.apikey).toBe("chave");
    expect(JSON.parse(send.body)).toEqual({ number: "1@g.us", mediatype: "image", media: "https://x/y.jpg", caption: "legenda" });

    const events: string[] = [];
    provider.onGroupEvent((event) => events.push(`${event.action}:${event.participants[0]}`));
    provider.onMessage((message) => events.push(message.text));
    provider.handleWebhook({ event: "group-participants.update", data: { id: "1@g.us", action: "add", participants: ["55@s"] } });
    provider.handleWebhook({ event: "MESSAGES_UPSERT", data: { key: { remoteJid: "55@s" }, message: { conversation: "ok" } } });
    provider.handleWebhook({ event: "messages.upsert", data: { key: { remoteJid: "1@g.us" }, message: { conversation: "de grupo" } } });
    expect(events).toEqual(["add:55@s", "ok"]);
  });
});

describe("chaves pelo painel", () => {
  const store = () => {
    const db = openDb(":memory:");
    return { db, store: new IntegrationStore(db, "s".repeat(40), { shopee_app_id: "do-arquivo", nvidia_model: "modelo/padrao" }) };
  };

  it("guarda criptografado e nunca devolve o segredo", () => {
    const { db, store: s } = store();
    s.set("shopee_secret", "segredo-muito-longo-1234");
    expect(s.get("shopee_secret")).toBe("segredo-muito-longo-1234");
    const raw = db.prepare("SELECT value FROM settings WHERE key = 'integration:shopee_secret'").get() as { value: string };
    expect(raw.value).not.toContain("segredo");
    const text = JSON.stringify(s.describe());
    expect(text).not.toContain("segredo-muito");
    expect(text).toContain('"ending":"1234"');
  });

  it("painel tem prioridade sobre o arquivo e apagar volta para o arquivo", () => {
    const { store: s } = store();
    expect(s.get("shopee_app_id")).toBe("do-arquivo");
    s.set("shopee_app_id", "do-painel");
    expect(s.get("shopee_app_id")).toBe("do-painel");
    s.set("shopee_app_id", null);
    expect(s.get("shopee_app_id")).toBe("do-arquivo");
  });

  it("troca de chave e de provedor valem na hora", () => {
    const { store: s } = store();
    const shopee = new ConfiguredShopee(s, "http://127.0.0.1:1");
    const writer = new ConfiguredWriter(s);
    expect(shopee.configured()).toBe(false);
    expect(writer.configured()).toBe(false);
    s.set("shopee_secret", "abc");
    s.set("nvidia_api_key", "nvapi-x");
    expect(shopee.configured()).toBe(true);
    expect(writer.configured()).toBe(true);
    s.set("ai_provider", "anthropic");
    expect(writer.configured()).toBe(false);
  });
});
