import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticator } from "otplib";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../server/app.ts";
import { loadConfig } from "../server/config.ts";
import { IntegrationStore } from "../server/integrations.ts";
import { DEFAULT_SETTINGS, saveSettings } from "../server/settings.ts";
import { harness, product, SECRET } from "./helpers.ts";

const SETUP_TOKEN = "t".repeat(24);
const EMAIL = "dono@example.com";
const PASSWORD = "uma-senha-bem-longa";
const JSON_HEADERS = { "content-type": "application/json" };

let h: ReturnType<typeof harness>;
let app: FastifyInstance;
let time: number;

const cookieOf = (response: { headers: Record<string, unknown> }) => String(response.headers["set-cookie"]).split(";")[0]!;

async function setup(): Promise<{ cookie: string; secret: string }> {
  const created = await app.inject({
    method: "POST", url: "/api/auth/setup", headers: JSON_HEADERS,
    payload: { token: SETUP_TOKEN, email: EMAIL, password: PASSWORD },
  });
  expect(created.statusCode).toBe(200);
  const secret = created.json<{ secret: string }>().secret;
  const confirmed = await app.inject({
    method: "POST", url: "/api/auth/totp", headers: { ...JSON_HEADERS, cookie: cookieOf(created) },
    payload: { code: authenticator.generate(secret) },
  });
  expect(confirmed.statusCode).toBe(200);
  return { cookie: cookieOf(confirmed), secret };
}

beforeEach(async () => {
  time = Date.parse("2026-11-09T12:00:00-03:00");
  vi.spyOn(Date, "now").mockImplementation(() => time);
  h = harness();
  const config = loadConfig({ APP_SECRET: SECRET, SETUP_TOKEN } as NodeJS.ProcessEnv);
  app = await buildApp({ db: h.db, config, engine: h.engine, shopee: h.shopee, writer: h.writer, whatsapp: h.whatsapp, integrations: new IntegrationStore(h.db, SECRET, { shopee_secret: "segredo-vindo-do-arquivo" }) });
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

describe("acesso", () => {
  it("bloqueia rotas sem login", async () => {
    for (const url of ["/api/status", "/api/settings", "/api/offers", "/api/groups", "/api/logs", "/api/dashboard?from=2026-11-01&to=2026-11-09"]) {
      expect((await app.inject({ url })).statusCode).toBe(401);
    }
  });

  it("exige o código de instalação", async () => {
    const response = await app.inject({
      method: "POST", url: "/api/auth/setup", headers: JSON_HEADERS,
      payload: { token: "errado", email: EMAIL, password: PASSWORD },
    });
    expect(response.statusCode).toBe(403);
  });

  it("recusa senha curta e nova instalação depois de pronta", async () => {
    const weak = await app.inject({
      method: "POST", url: "/api/auth/setup", headers: JSON_HEADERS,
      payload: { token: SETUP_TOKEN, email: EMAIL, password: "curta" },
    });
    expect(weak.statusCode).toBe(400);
    await setup();
    const again = await app.inject({
      method: "POST", url: "/api/auth/setup", headers: JSON_HEADERS,
      payload: { token: SETUP_TOKEN, email: "outro@example.com", password: PASSWORD },
    });
    expect(again.statusCode).toBe(409);
  });

  it("senha sozinha não libera o painel; 2FA libera e o mesmo código não vale duas vezes", async () => {
    const { secret } = await setup();
    const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: JSON_HEADERS, payload: { email: EMAIL, password: PASSWORD } });
    expect(login.statusCode).toBe(200);
    const pre = cookieOf(login);
    expect((await app.inject({ url: "/api/status", headers: { cookie: pre } })).statusCode).toBe(401);

    const replay = await app.inject({
      method: "POST", url: "/api/auth/totp", headers: { ...JSON_HEADERS, cookie: pre },
      payload: { code: authenticator.generate(secret) },
    });
    expect(replay.statusCode).toBe(401);

    time += 31_000;
    const ok = await app.inject({
      method: "POST", url: "/api/auth/totp", headers: { ...JSON_HEADERS, cookie: pre },
      payload: { code: authenticator.generate(secret) },
    });
    expect(ok.statusCode).toBe(200);
    expect(String(ok.headers["set-cookie"])).toMatch(/HttpOnly/);
    expect(String(ok.headers["set-cookie"])).toMatch(/SameSite=Strict/);
    expect((await app.inject({ url: "/api/status", headers: { cookie: cookieOf(ok) } })).statusCode).toBe(200);
  });

  it("aceita celular com relógio até 3 minutos à frente, mas não além disso", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/auth/setup", headers: JSON_HEADERS,
      payload: { token: SETUP_TOKEN, email: EMAIL, password: PASSWORD },
    });
    const { secret } = created.json<{ secret: string }>();
    const headers = { ...JSON_HEADERS, cookie: cookieOf(created) };
    const farAhead = authenticator.clone({ epoch: time + 240_000 }).generate(secret);
    expect((await app.inject({ method: "POST", url: "/api/auth/totp", headers, payload: { code: farAhead } })).statusCode).toBe(401);
    const ahead = authenticator.clone({ epoch: time + 120_000 }).generate(secret);
    expect((await app.inject({ method: "POST", url: "/api/auth/totp", headers, payload: { code: ahead } })).statusCode).toBe(200);
  });

  it("trava depois de muitas senhas erradas", async () => {
    await setup();
    let last = 0;
    for (let i = 0; i < 9; i++) {
      last = (await app.inject({ method: "POST", url: "/api/auth/login", headers: JSON_HEADERS, payload: { email: EMAIL, password: "errada" } })).statusCode;
    }
    expect(last).toBe(429);
  });

  it("logout encerra a sessão", async () => {
    const { cookie } = await setup();
    await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect((await app.inject({ url: "/api/status", headers: { cookie } })).statusCode).toBe(401);
  });

  it("recusa escrita vinda de outro site", async () => {
    const { cookie } = await setup();
    const response = await app.inject({
      method: "PUT", url: "/api/settings",
      headers: { ...JSON_HEADERS, cookie, host: "localhost:3000", origin: "https://site-malicioso.com" },
      payload: DEFAULT_SETTINGS,
    });
    expect(response.statusCode).toBe(403);
  });

  it("envia cabeçalhos de segurança", async () => {
    const response = await app.inject({ url: "/api/auth/state" });
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("operação pelo painel", () => {
  it("valida configurações", async () => {
    const { cookie } = await setup();
    const response = await app.inject({
      method: "PUT", url: "/api/settings", headers: { ...JSON_HEADERS, cookie },
      payload: { ...DEFAULT_SETTINGS, layout: "oferta sem o link" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("{link}");
  });

  it("não aceita limite acima do seguro", async () => {
    const { cookie } = await setup();
    const response = await app.inject({
      method: "PUT", url: "/api/settings", headers: { ...JSON_HEADERS, cookie },
      payload: { ...DEFAULT_SETTINGS, preset: "personalizado", custom: { ...DEFAULT_SETTINGS.custom, maxPerMinute: 30 } },
    });
    expect(response.statusCode).toBe(400);
  });

  it("cadastra grupo, envia oferta manual e aparece na fila", async () => {
    const { cookie } = await setup();
    const headers = { ...JSON_HEADERS, cookie };
    const group = await app.inject({
      method: "POST", url: "/api/groups", headers,
      payload: { jid: "123-456@g.us", name: "Casa", code: "casa01", categoryIds: [], active: true, auto: false, approval: false, windowStart: null, windowEnd: null },
    });
    expect(group.statusCode).toBe(200);
    h.shopee.products = [product(9)];
    const search = await app.inject({ url: "/api/products/search?q=panela", headers: { cookie } });
    expect(search.json<unknown[]>()).toHaveLength(1);
    const manual = await app.inject({
      method: "POST", url: "/api/offers/manual", headers,
      payload: { groupIds: [group.json<{ id: number }>().id], mode: "priority", itemId: "9" },
    });
    expect(manual.statusCode).toBe(200);
    const queue = await app.inject({ url: "/api/offers", headers: { cookie } });
    expect(queue.json<{ status: string; commission_rate: number }[]>()[0]).toMatchObject({ status: "queued", commission_rate: 8 });
  });

  it("cadastra cupom em maiúsculas, desativa e recusa código inválido", async () => {
    const { cookie } = await setup();
    const headers = { ...JSON_HEADERS, cookie };
    const payload = { code: "shopee20", kind: "percent", value: 20, minPrice: 0, maxDiscount: 15, categoryId: null, expiresOn: "2026-12-31", active: true };
    const created = await app.inject({ method: "POST", url: "/api/coupons", headers, payload });
    expect(created.statusCode).toBe(200);
    const list = await app.inject({ url: "/api/coupons", headers: { cookie } });
    expect(list.json<{ code: string }[]>()[0]?.code).toBe("SHOPEE20");
    const off = await app.inject({ method: "PUT", url: `/api/coupons/${created.json<{ id: number }>().id}/active`, headers, payload: { active: false } });
    expect(off.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/coupons", headers, payload: { ...payload, code: "*X* y" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/coupons", headers, payload: { ...payload, value: 100 } })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/coupons" })).statusCode).toBe(401);
  });

  it("salva várias categorias e comissão mínima no grupo", async () => {
    const { cookie } = await setup();
    const headers = { ...JSON_HEADERS, cookie };
    const payload = { jid: "9-9@g.us", name: "Amplo", code: "amplo", categoryIds: [1, 2, 3, 2], minCommissionValue: 5, minCommissionRate: 8, active: true, auto: true, approval: false, windowStart: null, windowEnd: null };
    const created = await app.inject({ method: "POST", url: "/api/groups", headers, payload });
    expect(created.statusCode).toBe(200);
    const id = created.json<{ id: number }>().id;
    const read = async () => (await app.inject({ url: "/api/groups", headers: { cookie } })).json<{ category_ids: number[]; min_commission_value: number }[]>()[0]!;
    expect((await read()).category_ids.sort()).toEqual([1, 2, 3]);
    expect((await read()).min_commission_value).toBe(5);
    expect((await app.inject({ method: "PUT", url: `/api/groups/${id}`, headers, payload: { ...payload, categoryIds: [] } })).statusCode).toBe(200);
    expect((await read()).category_ids).toEqual([]);
    expect((await app.inject({ method: "PUT", url: `/api/groups/${id}`, headers, payload: { ...payload, categoryIds: [9999] } })).statusCode).toBe(400);
  });

  it("salva chaves no painel sem devolver o segredo e testa a conexão", async () => {
    const { cookie } = await setup();
    const headers = { ...JSON_HEADERS, cookie };
    expect((await app.inject({ url: "/api/integrations" })).statusCode).toBe(401);
    const saved = await app.inject({ method: "PUT", url: "/api/integrations", headers, payload: { values: { nvidia_api_key: "nvapi-chave-secreta-9876" } } });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain("chave-secreta");
    expect(saved.body).toContain("9876");
    const listed = await app.inject({ url: "/api/integrations", headers: { cookie } });
    expect(listed.body).not.toContain("segredo-vindo-do-arquivo");
    expect((await app.inject({ method: "PUT", url: "/api/integrations", headers, payload: { values: { ai_provider: "invalido" } } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/integrations", headers, payload: { values: { outra: "x" } } })).statusCode).toBe(400);
    h.shopee.products = [product(1)];
    const test = await app.inject({ method: "POST", url: "/api/integrations/shopee/test", headers: { cookie } });
    expect(test.json<{ ok: boolean }>().ok).toBe(true);
  });

  it("informa se a automação do grupo está ativa e o motivo", async () => {
    const { cookie } = await setup();
    const group = h.addGroup("a");
    const state = async () => (await app.inject({ url: "/api/groups", headers: { cookie } })).json<{ automation: { running: boolean; reason: string } }[]>()[0]!.automation;
    expect(await state()).toEqual({ running: false, reason: "Modo automático geral desligado em Ajustes" });
    saveSettings(h.db, { ...DEFAULT_SETTINGS, autoMode: true });
    expect(await state()).toEqual({ running: true, reason: "Enviando no ritmo configurado" });
    h.whatsapp.state = { state: "disconnected" };
    expect((await state()).reason).toBe("WhatsApp desconectado");
    h.whatsapp.state = { state: "open" };
    h.db.prepare("UPDATE groups SET approval = 1 WHERE id = ?").run(group.id);
    expect(await state()).toEqual({ running: true, reason: "Envia depois da sua aprovação" });
    h.db.prepare("UPDATE groups SET window_start = '22:00', window_end = '23:00' WHERE id = ?").run(group.id);
    expect(await state()).toEqual({ running: true, reason: "Fora do horário. Volta às 22:00" });
    h.db.exec("UPDATE categories SET active = 0");
    expect(await state()).toEqual({ running: false, reason: "Escolha pelo menos uma categoria ativa" });
    h.db.prepare("UPDATE groups SET auto = 0 WHERE id = ?").run(group.id);
    expect(await state()).toEqual({ running: false, reason: "Automação desligada neste grupo" });
  });

  it("um produto ruim não derruba a busca", async () => {
    const { cookie } = await setup();
    h.shopee.products = [product(1, { productLink: "" }), product(2)];
    const response = await app.inject({ url: "/api/products/search?q=panela", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ itemId: string }[]>().map((p) => p.itemId)).toEqual(["2"]);
  });

  it("explica cadastro duplicado", async () => {
    const { cookie } = await setup();
    const response = await app.inject({
      method: "POST", url: "/api/categories", headers: { ...JSON_HEADERS, cookie },
      payload: { name: "Pets", code: "pets", keywords: ["ração"], active: true },
    });
    expect(response.statusCode).toBe(409);
  });

  it("recusa grupo com identificador inválido", async () => {
    const { cookie } = await setup();
    const response = await app.inject({
      method: "POST", url: "/api/groups", headers: { ...JSON_HEADERS, cookie },
      payload: { jid: "5571999@s.whatsapp.net", name: "X", code: "x", categoryIds: [], active: true, auto: true, approval: false, windowStart: null, windowEnd: null },
    });
    expect(response.statusCode).toBe(400);
  });

  it("dashboard separa comissão pendente, validada, valor vendido, grupo e leads", async () => {
    const { cookie } = await setup();
    const group = h.addGroup("casa01");
    const when = Date.parse("2026-11-05T15:00:00-03:00") / 1000;
    const item = { orderId: "a", itemId: "1", itemName: "Panela", purchaseTime: when, utmContent: "casa01-casa-auto-20261105-1" };
    h.shopee.items = [
      { ...item, key: "1", status: "pending", gmv: 100, commission: 8 },
      { ...item, key: "2", orderId: "b", status: "validated", gmv: 50, commission: 4 },
      { ...item, key: "3", orderId: "c", status: "canceled", gmv: 999, commission: 99 },
    ];
    await h.engine.syncConversions();
    h.db.prepare("INSERT INTO group_events (group_id, participant_hash, action, ts) VALUES (?, 'x', 'add', ?), (?, 'y', 'remove', ?)").run(group.id, when, group.id, when);

    const response = await app.inject({ url: `/api/dashboard?from=2026-11-01&to=2026-11-09&groupId=${group.id}`, headers: { cookie } });
    const data = response.json<{
      totals: Record<string, number>;
      daily: { day: string }[];
      byGroup: { name: string; commission: number }[];
      leads: { joined: number; left: number };
    }>();
    expect(data.totals).toEqual({ commission: 12, validated: 4, pending: 8, gmv: 150, orders: 2 });
    expect(data.daily[0]?.day).toBe("2026-11-05");
    expect(data.byGroup[0]).toMatchObject({ name: "casa01", commission: 12 });
    expect(data.leads).toEqual({ joined: 1, left: 1, daily: expect.any(Array) });
  });
});
