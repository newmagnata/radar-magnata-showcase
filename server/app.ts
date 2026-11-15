import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import QRCode from "qrcode";
import { z, ZodError } from "zod";
import { AuthService, safeEqual } from "./auth.ts";
import type { Config } from "./config.ts";
import { dashboard } from "./dashboard.ts";
import type { Db } from "./db.ts";
import type { Engine, GroupRow } from "./engine.ts";
import { PRIORITY } from "./engine.ts";
import { activeRate, getSettings, insideWindow, PRESETS, saoPauloClock, saoPauloDayStart, saveSettings, settingsSchema } from "./settings.ts";
import type { ShopeeApi, ShopeeProduct } from "./shopee.ts";
import { ShopeeError } from "./shopee.ts";
import type { IntegrationStore } from "./integrations.ts";
import { AI_PROVIDERS, INTEGRATION_KEYS } from "./integrations.ts";
import type { HeadlineWriter } from "./writer.ts";
import type { WhatsAppProvider } from "./whatsapp.ts";
import { EvolutionProvider } from "./whatsapp.ts";

const COOKIE = "radar_session";
const code = z.string().regex(/^[a-z0-9]{1,20}$/, "Use só letras minúsculas e números, sem espaços");
const emailSchema = z.string().trim().email().max(200);
const passwordSchema = z.string().min(12, "A senha precisa ter 12 caracteres ou mais").max(200);
const totpSchema = z.object({ code: z.string().regex(/^\d{6}$/, "Digite os 6 números do aplicativo") });
const idParam = z.object({ id: z.coerce.number().int().positive() });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const windowTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable();

const groupSchema = z
  .object({
    jid: z.string().regex(/^[\d-]+@g\.us$/, "Identificador de grupo inválido"),
    name: z.string().trim().min(1).max(100),
    code,
    categoryIds: z.array(z.number().int().positive()).max(50),
    minCommissionValue: z.number().min(0).max(100_000).default(0),
    minCommissionRate: z.number().min(0).max(100).default(0),
    active: z.boolean(),
    auto: z.boolean(),
    approval: z.boolean(),
    windowStart: windowTime,
    windowEnd: windowTime,
  })
  .strict();

const categorySchema = z
  .object({
    name: z.string().trim().min(2).max(60),
    code,
    keywords: z.array(z.string().trim().min(2).max(60)).min(1).max(20),
    active: z.boolean(),
  })
  .strict();

const productSchema = z.object({
  itemId: z.string().regex(/^\d+$/),
  name: z.string().min(1).max(400),
  imageUrl: z.string().url(),
  productLink: z.string().url(),
  price: z.number().nonnegative(),
  discountRate: z.number().min(0).max(100),
  commissionRate: z.number().min(0),
  rating: z.number().min(0).max(5),
  sales: z.number().nonnegative(),
  shopName: z.string().max(200),
  officialStore: z.boolean(),
});

const manualSchema = z
  .object({
    groupIds: z.array(z.number().int().positive()).min(1).max(30),
    mode: z.enum(["priority", "bypass"]),
    itemId: z.string().regex(/^\d+$/),
    coupon: z.union([z.literal("auto"), z.literal("none"), z.number().int().positive()]).default("auto"),
    categoryId: z.number().int().positive().nullable().default(null),
  })
  .strict();

const couponSchema = z
  .object({
    code: z.string().trim().regex(/^[A-Za-z0-9_-]{3,30}$/, "O código do cupom só pode ter letras, números, hífen e sublinhado").transform((v) => v.toUpperCase()),
    kind: z.enum(["percent", "fixed"]),
    value: z.number().positive("Informe o valor do desconto"),
    minPrice: z.number().min(0),
    maxDiscount: z.number().min(0),
    categoryId: z.number().int().positive().nullable(),
    expiresOn: day.nullable(),
    active: z.boolean(),
  })
  .strict()
  .refine((c) => c.kind !== "percent" || c.value < 100, { message: "O desconto em porcentagem precisa ser menor que 100" });

export interface AppDeps {
  db: Db;
  config: Config;
  engine: Engine;
  shopee: ShopeeApi;
  writer: HeadlineWriter;
  whatsapp: WhatsAppProvider;
  integrations: IntegrationStore;
}

const integrationSchema = z
  .object({ values: z.partialRecord(z.enum(INTEGRATION_KEYS), z.string().trim().max(500).nullable()) })
  .strict()
  .refine((body) => !body.values.ai_provider || AI_PROVIDERS.includes(body.values.ai_provider), { message: "Provedor de IA inválido" });

const SAMPLE_PRODUCT: ShopeeProduct = {
  itemId: "1",
  name: "Panela Antiaderente 24cm com Tampa de Vidro",
  imageUrl: "",
  productLink: "",
  price: 89.9,
  discountRate: 20,
  commissionRate: 8,
  rating: 4.8,
  sales: 1000,
  shopName: "",
  officialStore: false,
};

export async function buildApp({ db, config, engine, shopee, writer, whatsapp, integrations }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 100_000, trustProxy: config.COOKIE_SECURE });
  const auth = new AuthService(db, config.APP_SECRET);
  const searchCache = new Map<string, ShopeeProduct>();

  await app.register(helmet, {
    hsts: config.COOKIE_SECURE,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https://*.susercontent.com", "https://*.shopee.com.br"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: config.COOKIE_SECURE ? [] : null,
      },
    },
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });

  const setCookie = (reply: FastifyReply, token: string, maxAge: number): void => {
    reply.setCookie(COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: config.COOKIE_SECURE,
      path: "/",
      maxAge,
    });
  };

  const needAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    const session = auth.session(request.cookies[COOKIE]);
    if (!session?.totpOk) return reply.code(401).send({ error: "Faça login para continuar" });
  };

  const strict = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

  app.addHook("onRequest", async (request, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method) || !request.url.startsWith("/api/")) return;
    if (request.url.startsWith("/api/webhooks/")) return;
    const origin = request.headers.origin;
    if (!origin) return;
    let host = "";
    try {
      host = new URL(origin).host;
    } catch {
      // Origem malformada ou "null" cai na recusa abaixo.
    }
    if (host !== request.headers.host) return reply.code(403).send({ error: "Origem não permitida" });
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: error.issues[0]?.message ?? "Dados inválidos" });
    }
    if (error instanceof ShopeeError) return reply.code(502).send({ error: error.message });
    if (/UNIQUE constraint failed/.test(error.message)) return reply.code(409).send({ error: "Esse cadastro já existe" });
    if (/FOREIGN KEY constraint failed/.test(error.message)) return reply.code(400).send({ error: "Categoria ou grupo inexistente" });
    if (error.statusCode && error.statusCode < 500) return reply.code(error.statusCode).send({ error: "Pedido inválido" });
    console.error(error);
    return reply.code(500).send({ error: "Erro interno. Veja os registros do servidor." });
  });

  // ----- Autenticação -----
  app.get("/api/auth/state", async (request) => {
    const session = auth.session(request.cookies[COOKIE]);
    return {
      needsSetup: auth.needsSetup(),
      authenticated: Boolean(session?.totpOk),
      needsTotp: Boolean(session && !session.totpOk),
    };
  });

  app.post("/api/auth/setup", strict, async (request, reply) => {
    const body = z
      .object({ token: z.string().max(200), email: emailSchema, password: passwordSchema })
      .strict()
      .parse(request.body);
    if (!auth.needsSetup()) return reply.code(409).send({ error: "O acesso já foi configurado" });
    const attempt = `setup:${request.ip}`;
    if (auth.locked(attempt)) return reply.code(429).send({ error: "Muitas tentativas. Aguarde 15 minutos." });
    if (!safeEqual(body.token, config.SETUP_TOKEN)) {
      auth.fail(attempt);
      return reply.code(403).send({ error: "Código de instalação incorreto" });
    }
    auth.clearFailures(attempt);
    const owner = await auth.createOwner(body.email, body.password);
    setCookie(reply, auth.startSession(owner.userId, false), 1200);
    const uri = auth.otpauth(body.email, owner.secret);
    return { qr: await QRCode.toDataURL(uri, { margin: 1, width: 280 }), secret: owner.secret };
  });

  app.post("/api/auth/login", strict, async (request, reply) => {
    const body = z.object({ email: emailSchema, password: z.string().max(200) }).strict().parse(request.body);
    const attempt = `login:${body.email.toLowerCase()}:${request.ip}`;
    if (auth.locked(attempt)) return reply.code(429).send({ error: "Muitas tentativas. Aguarde 15 minutos." });
    const user = await auth.checkPassword(body.email, body.password);
    if (!user) {
      auth.fail(attempt);
      return reply.code(401).send({ error: "E-mail ou senha incorretos" });
    }
    auth.clearFailures(attempt);
    setCookie(reply, auth.startSession(user.id, false), 1200);
    return { needsTotp: true };
  });

  app.post("/api/auth/totp", strict, async (request, reply) => {
    const { code: totp } = totpSchema.parse(request.body);
    const session = auth.session(request.cookies[COOKIE]);
    if (!session) return reply.code(401).send({ error: "Sessão expirada. Entre novamente." });
    const attempt = `totp:${session.userId}:${request.ip}`;
    if (auth.locked(attempt)) return reply.code(429).send({ error: "Muitas tentativas. Aguarde 15 minutos." });
    if (!auth.checkTotp(session.userId, totp)) {
      auth.fail(attempt);
      return reply.code(401).send({ error: "Código incorreto ou já usado" });
    }
    auth.clearFailures(attempt);
    auth.endSession(request.cookies[COOKIE]);
    setCookie(reply, auth.startSession(session.userId, true), 7 * 86_400);
    return { ok: true };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    auth.endSession(request.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  // ----- Webhook da Evolution API (fase da VPS) -----
  app.post("/api/webhooks/evolution/:secret", async (request, reply) => {
    const { secret } = z.object({ secret: z.string().max(200) }).parse(request.params);
    if (!config.EVOLUTION_WEBHOOK_SECRET || !safeEqual(secret, config.EVOLUTION_WEBHOOK_SECRET)) {
      return reply.code(403).send({ error: "Não autorizado" });
    }
    if (whatsapp instanceof EvolutionProvider) whatsapp.handleWebhook(request.body as { event?: string });
    return { ok: true };
  });

  // ----- Rotas protegidas -----
  await app.register(async (api) => {
    api.addHook("preHandler", needAuth);

    api.get("/api/status", async () => ({
      whatsapp: whatsapp.status(),
      shopee: shopee.configured(),
      ai: writer.configured(),
      settings: getSettings(db),
      rate: activeRate(getSettings(db)),
      queue: db
        .prepare("SELECT status, COUNT(*) AS n FROM offers WHERE status IN ('queued','pending_approval') GROUP BY status")
        .all(),
    }));

    api.get("/api/dashboard", async (request) => {
      const query = z
        .object({
          from: day,
          to: day,
          groupId: z.coerce.number().int().positive().optional(),
          categoryId: z.coerce.number().int().positive().optional(),
        })
        .parse(request.query);
      return dashboard(db, query);
    });

    api.get("/api/settings", async () => ({ settings: getSettings(db), presets: PRESETS }));
    api.put("/api/settings", async (request) => {
      const settings = settingsSchema.parse(request.body);
      saveSettings(db, settings);
      return { settings };
    });

    api.get("/api/categories", async () =>
      (db.prepare("SELECT * FROM categories ORDER BY name").all() as unknown as { keywords: string }[]).map((row) => ({
        ...row,
        keywords: JSON.parse(row.keywords) as string[],
      })),
    );
    api.post("/api/categories", async (request) => {
      const c = categorySchema.parse(request.body);
      return db
        .prepare("INSERT INTO categories (name, code, keywords, active) VALUES (?, ?, ?, ?) RETURNING id")
        .get(c.name, c.code, JSON.stringify(c.keywords), c.active ? 1 : 0);
    });
    api.put("/api/categories/:id", async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const c = categorySchema.parse(request.body);
      const result = db
        .prepare("UPDATE categories SET name = ?, code = ?, keywords = ?, active = ? WHERE id = ?")
        .run(c.name, c.code, JSON.stringify(c.keywords), c.active ? 1 : 0, id);
      if (!result.changes) return reply.code(404).send({ error: "Categoria não encontrada" });
      return { ok: true };
    });

    api.get("/api/integrations", async () => integrations.describe());
    api.put("/api/integrations", async (request) => {
      const { values } = integrationSchema.parse(request.body);
      for (const [key, value] of Object.entries(values)) integrations.set(key as (typeof INTEGRATION_KEYS)[number], value ?? null);
      return integrations.describe();
    });
    api.post("/api/integrations/:id/test", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request) => {
      const { id } = z.object({ id: z.enum(["shopee", "nvidia", "anthropic"]) }).parse(request.params);
      try {
        if (id === "shopee") {
          if (!shopee.configured()) return { ok: false, message: "Preencha o App ID e o Secret" };
          const products = await shopee.search({ keyword: "panela", sortType: 2, limit: 1 });
          return { ok: products.length > 0, message: products.length > 0 ? "Conectado: a Shopee respondeu com produtos" : "A Shopee respondeu, mas sem produtos" };
        }
        const candidate = integrations.writerFor(id);
        if (!candidate) return { ok: false, message: "Preencha a chave da API" };
        const copy = await candidate.headline(SAMPLE_PRODUCT);
        return copy ? { ok: true, message: `Conectado. Exemplo: ${copy.headline}` } : { ok: false, message: "A IA respondeu, mas sem texto aproveitável. Tente de novo ou troque o modelo." };
      } catch (error) {
        return { ok: false, message: (error as Error).message.slice(0, 200) };
      }
    });

    api.get("/api/coupons", async () => db.prepare("SELECT * FROM coupons ORDER BY active DESC, id DESC").all());
    api.post("/api/coupons", async (request) => {
      const c = couponSchema.parse(request.body);
      return db
        .prepare("INSERT INTO coupons (code, kind, value, min_price, max_discount, category_id, expires_on, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
        .get(c.code, c.kind, c.value, c.minPrice, c.maxDiscount, c.categoryId, c.expiresOn, c.active ? 1 : 0, Date.now());
    });
    api.put("/api/coupons/:id/active", async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { active } = z.object({ active: z.boolean() }).strict().parse(request.body);
      const result = db.prepare("UPDATE coupons SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
      if (!result.changes) return reply.code(404).send({ error: "Cupom não encontrado" });
      return { ok: true };
    });

    /** Verde só quando nada impede o grupo de receber ofertas automáticas. */
    const automationOf = (row: GroupRow & { has_active_category: number; sent_today: number }) => {
      const settings = getSettings(db);
      const stopped = (reason: string) => ({ running: false, reason });
      if (!row.active) return stopped("Grupo desativado");
      if (!row.auto) return stopped("Automação desligada neste grupo");
      if (!settings.autoMode) return stopped("Modo automático geral desligado em Ajustes");
      if (whatsapp.status().state !== "open") return stopped("WhatsApp desconectado");
      if (!shopee.configured()) return stopped("Chaves da Shopee não preenchidas");
      if (!row.has_active_category) return stopped("Escolha pelo menos uma categoria ativa");
      const start = row.window_start ?? settings.windowStart;
      const end = row.window_end ?? settings.windowEnd;
      let reason = "Enviando no ritmo configurado";
      if (row.sent_today >= activeRate(settings).maxPerDay) reason = "Limite de ofertas de hoje atingido";
      else if (!insideWindow(saoPauloClock(Date.now()), start, end)) reason = `Fora do horário. Volta às ${start}`;
      else if (row.approval) reason = "Envia depois da sua aprovação";
      return { running: true, reason };
    };

    api.get("/api/groups", async () =>
      (
        db
          .prepare(
            `SELECT g.*,
               (SELECT json_group_array(category_id) FROM group_categories WHERE group_id = g.id) AS category_ids,
               EXISTS (SELECT 1 FROM group_categories gc JOIN categories c ON c.id = gc.category_id WHERE gc.group_id = g.id AND c.active = 1) AS has_active_category,
               (SELECT COUNT(*) FROM offers o WHERE o.group_id = g.id AND o.status = 'sent' AND o.sent_at >= ?) AS sent_today
             FROM groups g ORDER BY g.name`,
          )
          .all(saoPauloDayStart(Date.now())) as unknown as (GroupRow & { category_ids: string; has_active_category: number; sent_today: number })[]
      ).map((row) => ({ ...row, category_ids: JSON.parse(row.category_ids) as number[], automation: automationOf(row) })),
    );
    const groupValues = (g: z.output<typeof groupSchema>) =>
      [g.name, g.code, g.active ? 1 : 0, g.auto ? 1 : 0, g.approval ? 1 : 0, g.windowStart, g.windowEnd, g.minCommissionValue, g.minCommissionRate] as const;
    const atomic = <T>(run: () => T): T => {
      db.exec("BEGIN");
      try {
        const result = run();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    };
    const saveCategories = (groupId: number, categoryIds: number[]): void => {
      db.prepare("DELETE FROM group_categories WHERE group_id = ?").run(groupId);
      const insert = db.prepare("INSERT INTO group_categories (group_id, category_id) VALUES (?, ?)");
      for (const categoryId of new Set(categoryIds)) insert.run(groupId, categoryId);
    };
    api.post("/api/groups", async (request) => {
      const g = groupSchema.parse(request.body);
      return atomic(() => {
        const row = db
          .prepare(
            `INSERT INTO groups (name, code, active, auto, approval, window_start, window_end, min_commission_value, min_commission_rate, jid)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          )
          .get(...groupValues(g), g.jid) as { id: number };
        saveCategories(row.id, g.categoryIds);
        return row;
      });
    });
    api.put("/api/groups/:id", async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const g = groupSchema.parse(request.body);
      const found = atomic(() => {
        const result = db
          .prepare(
            `UPDATE groups SET name = ?, code = ?, active = ?, auto = ?, approval = ?, window_start = ?, window_end = ?,
               min_commission_value = ?, min_commission_rate = ?, jid = ?
             WHERE id = ?`,
          )
          .run(...groupValues(g), g.jid, id);
        if (result.changes) saveCategories(id, g.categoryIds);
        return result.changes > 0;
      });
      if (!found) return reply.code(404).send({ error: "Grupo não encontrado" });
      return { ok: true };
    });

    api.post("/api/whatsapp/connect", async () => {
      await whatsapp.start();
      return whatsapp.status();
    });
    api.get("/api/whatsapp/groups", async (_request, reply) => {
      if (whatsapp.status().state !== "open") return reply.code(409).send({ error: "Conecte o WhatsApp primeiro" });
      return whatsapp.listGroups();
    });

    api.get("/api/offers", async (request) => {
      const { scope } = z.object({ scope: z.enum(["open", "history"]).default("open") }).parse(request.query);
      const filter =
        scope === "open"
          ? "o.status IN ('pending_approval','queued','sending') ORDER BY o.priority DESC, o.id"
          : "o.status NOT IN ('pending_approval','queued','sending','draft') ORDER BY o.id DESC LIMIT 100";
      return db
        .prepare(
          `SELECT o.id, o.status, o.origin, o.priority, o.text, o.error, o.created_at, o.sent_at,
                  p.name AS product, p.image_url, p.price, p.commission_rate, g.name AS group_name
           FROM offers o JOIN products p ON p.id = o.product_id JOIN groups g ON g.id = o.group_id WHERE ${filter}`,
        )
        .all();
    });

    const decide = (approved: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      if (!engine.decide(id, approved)) return reply.code(409).send({ error: "Esta oferta não está aguardando aprovação" });
      return { ok: true };
    };
    api.post("/api/offers/:id/approve", decide(true));
    api.post("/api/offers/:id/reject", decide(false));
    api.post("/api/offers/:id/cancel", async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const result = db.prepare("UPDATE offers SET status = 'canceled' WHERE id = ? AND status IN ('queued','pending_approval')").run(id);
      if (!result.changes) return reply.code(409).send({ error: "Esta oferta não pode mais ser cancelada" });
      return { ok: true };
    });

    api.get("/api/products/search", async (request) => {
      const query = z
        .object({ q: z.string().trim().min(2).max(100), sort: z.enum(["vendas", "comissao"]).default("vendas") })
        .parse(request.query);
      const products = await shopee.search({ keyword: query.q, sortType: query.sort === "vendas" ? 2 : 5, limit: 24 });
      const valid = products.filter((product) => productSchema.safeParse(product).success);
      for (const product of valid) searchCache.set(product.itemId, product);
      while (searchCache.size > 500) searchCache.delete(searchCache.keys().next().value as string);
      return valid;
    });

    api.post("/api/offers/manual", async (request, reply) => {
      const body = manualSchema.parse(request.body);
      const product = searchCache.get(body.itemId);
      if (!product) return reply.code(404).send({ error: "Busque o produto novamente antes de enviar" });
      const created: number[] = [];
      const failed: string[] = [];
      for (const groupId of body.groupIds) {
        const group = db.prepare("SELECT * FROM groups WHERE id = ?").get(groupId) as GroupRow | undefined;
        if (!group) {
          failed.push(`Grupo ${groupId} não encontrado`);
          continue;
        }
        try {
          created.push(await engine.createOffer(product, group, "manual", body.mode === "bypass" ? PRIORITY.bypass : PRIORITY.manual, body.coupon, body.categoryId));
        } catch (error) {
          failed.push(`${group.name}: ${(error as Error).message}`);
        }
      }
      if (created.length === 0) return reply.code(502).send({ error: failed[0] ?? "Nenhuma oferta criada" });
      return { created, failed };
    });

    api.post("/api/shopee/sync", async () => ({ items: await engine.syncConversions() }));
    api.get("/api/logs", async () => db.prepare("SELECT * FROM logs ORDER BY id DESC LIMIT 100").all());
  });

  const dist = resolve("dist");
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "Não encontrado" });
      return reply.sendFile("index.html");
    });
  }
  return app;
}
