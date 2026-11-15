import { createHmac } from "node:crypto";
import type { AppliedCoupon, CouponRow } from "./coupons.ts";
import { applyCoupon, bestCoupon, isOpen, whyNot } from "./coupons.ts";
import type { Db } from "./db.ts";
import { log } from "./db.ts";
import type { Rate, Settings } from "./settings.ts";
import { activeRate, getSettings, insideWindow, saoPauloClock, saoPauloDayStart } from "./settings.ts";
import type { ShopeeApi, ShopeeProduct } from "./shopee.ts";
import { allowedImage } from "./shopee.ts";
import type { HeadlineWriter, OfferCopy } from "./writer.ts";
import { fallbackHeadline, renderOffer } from "./writer.ts";
import type { GroupEvent, InboundMessage, WhatsAppProvider } from "./whatsapp.ts";

export const PRIORITY = { normal: 0, manual: 1, bypass: 2 } as const;
export type CouponChoice = "auto" | "none" | number;
const OFFER_TTL = 24 * 3_600_000;
const QUEUE_TARGET = 2;

export interface GroupRow {
  id: number;
  jid: string;
  name: string;
  code: string;
  min_commission_value: number;
  min_commission_rate: number;
  active: number;
  auto: number;
  approval: number;
  window_start: string | null;
  window_end: string | null;
  next_send_at: number;
}

interface OfferRow {
  id: number;
  product_id: number;
  group_id: number;
  priority: number;
  text: string;
  attempts: number;
  coupon_id: number | null;
  image_url: string;
  jid: string;
}

interface Deps {
  db: Db;
  shopee: ShopeeApi;
  writer: HeadlineWriter;
  whatsapp: WhatsAppProvider;
  secret: string;
  now?: () => number;
  random?: () => number;
}

export function sameBrazilNumber(a: string, b: string): boolean {
  const normal = (raw: string): string => {
    const digits = raw.split("@")[0]!.split(":")[0]!.replace(/\D/g, "");
    return digits.startsWith("55") && digits.length === 13 ? `${digits.slice(0, 4)}${digits.slice(5)}` : digits;
  };
  const left = normal(a);
  return left.length >= 10 && left === normal(b);
}

export class Engine {
  private readonly db: Db;
  private readonly shopee: ShopeeApi;
  private readonly writer: HeadlineWriter;
  private readonly whatsapp: WhatsAppProvider;
  private readonly secret: string;
  private readonly now: () => number;
  private readonly random: () => number;
  private nextNumberAt = 0;
  private ticking = false;
  private lastState = "";

  constructor(deps: Deps) {
    this.db = deps.db;
    this.shopee = deps.shopee;
    this.writer = deps.writer;
    this.whatsapp = deps.whatsapp;
    this.secret = deps.secret;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    deps.whatsapp.onGroupEvent((event) => {
      try {
        this.recordGroupEvent(event);
      } catch (error) {
        log(this.db, "error", `Evento de grupo: ${(error as Error).message}`, this.now());
      }
    });
    deps.whatsapp.onMessage((message) => {
      this.handleInbound(message).catch((error: Error) => log(this.db, "error", `Mensagem recebida: ${error.message}`, this.now()));
    });
    this.recover();
  }

  /** Um envio interrompido não volta para a fila: reenviar poderia duplicar a oferta no grupo. */
  private recover(): void {
    this.db
      .prepare("UPDATE offers SET status = 'failed', error = 'Envio interrompido ao reiniciar' WHERE status = 'sending'")
      .run();
    const last = this.db.prepare("SELECT MAX(sent_at) AS at FROM offers").get() as { at: number | null };
    if (last.at) this.nextNumberAt = last.at + 60_000;
  }

  private between(min: number, max: number): number {
    return min + (max - min) * this.random();
  }

  private groupById(id: number): GroupRow | undefined {
    return this.db.prepare("SELECT * FROM groups WHERE id = ?").get(id) as GroupRow | undefined;
  }

  private saveProduct(p: ShopeeProduct): number {
    const row = this.db
      .prepare(
        `INSERT INTO products (item_id, name, image_url, product_link, price, discount_rate, commission_rate, rating, sales, shop_name, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(item_id) DO UPDATE SET name = excluded.name, image_url = excluded.image_url, product_link = excluded.product_link,
           price = excluded.price, discount_rate = excluded.discount_rate, commission_rate = excluded.commission_rate,
           rating = excluded.rating, sales = excluded.sales, shop_name = excluded.shop_name, updated_at = excluded.updated_at
         RETURNING id`,
      )
      .get(p.itemId, p.name, p.imageUrl, p.productLink, p.price, p.discountRate, p.commissionRate, p.rating, p.sales, p.shopName, this.now()) as {
      id: number;
    };
    return row.id;
  }

  private categoryCode(categoryId: number | null): string {
    if (!categoryId) return "semcategoria";
    const row = this.db.prepare("SELECT code FROM categories WHERE id = ?").get(categoryId) as { code: string } | undefined;
    return row?.code ?? "semcategoria";
  }

  private async copyFor(product: ShopeeProduct, settings: Settings): Promise<OfferCopy> {
    if (settings.useAi && this.writer.configured()) {
      try {
        const copy = await this.writer.headline(product);
        if (copy) return copy;
      } catch (error) {
        log(this.db, "warn", `IA indisponível, usando frase padrão: ${(error as Error).message}`, this.now());
      }
    }
    return { headline: fallbackHeadline(this.random), title: null };
  }

  private groupCategoryIds(groupId: number): number[] {
    const rows = this.db.prepare("SELECT category_id FROM group_categories WHERE group_id = ?").all(groupId) as unknown as { category_id: number }[];
    return rows.map((row) => row.category_id);
  }

  /** Categoria que identifica a oferta nos relatórios e nas regras de cupom. */
  private resolveCategory(groupId: number, requested: number | null | undefined): number | null {
    const ids = this.groupCategoryIds(groupId);
    if (requested && ids.includes(requested)) return requested;
    return ids.length === 1 ? ids[0]! : null;
  }

  private chooseCoupon(choice: CouponChoice, product: ShopeeProduct, categoryId: number | null): AppliedCoupon | null {
    if (choice === "none") return null;
    if (choice === "auto") return bestCoupon(this.db, product.price, categoryId, this.now());
    const coupon = this.db.prepare("SELECT * FROM coupons WHERE id = ?").get(choice) as CouponRow | undefined;
    if (!coupon) throw new Error("Cupom não encontrado");
    const reason = whyNot(coupon, product.price, categoryId, this.now());
    if (reason) throw new Error(`O cupom ${coupon.code} ${reason}`);
    return applyCoupon(coupon, product.price);
  }

  async createOffer(
    product: ShopeeProduct,
    group: GroupRow,
    origin: "auto" | "manual",
    priority: number,
    couponChoice: CouponChoice = "auto",
    requestedCategory?: number | null,
  ): Promise<number> {
    if (!allowedImage(product.imageUrl)) throw new Error("Imagem do produto vem de um endereço não permitido");
    if (!product.productLink) throw new Error("Produto sem link");
    const settings = getSettings(this.db);
    const categoryId = this.resolveCategory(group.id, requestedCategory);
    const coupon = this.chooseCoupon(couponChoice, product, categoryId);
    const productId = this.saveProduct(product);
    const created = this.db
      .prepare("INSERT INTO offers (product_id, group_id, origin, priority, status, created_at, coupon_id) VALUES (?, ?, ?, ?, 'draft', ?, ?) RETURNING id")
      .get(productId, group.id, origin, priority, this.now(), coupon?.id ?? null) as { id: number };
    try {
      const day = new Date(this.now() - 3 * 3_600_000).toISOString().slice(0, 10).replaceAll("-", "");
      const subIds = [group.code, this.categoryCode(categoryId), origin, day, String(created.id)];
      const link = await this.shopee.shortLink(product.productLink, subIds);
      const copy = await this.copyFor(product, settings);
      const text = renderOffer(settings.layout, product, copy, link, coupon);
      const status = group.approval ? "pending_approval" : "queued";
      this.db.prepare("UPDATE offers SET text = ?, short_link = ?, status = ? WHERE id = ?").run(text, link, status, created.id);
      return created.id;
    } catch (error) {
      this.db.prepare("UPDATE offers SET status = 'failed', error = ? WHERE id = ?").run((error as Error).message.slice(0, 300), created.id);
      throw error;
    }
  }

  private recentlyOffered(itemId: string, groupId: number, rate: Rate): boolean {
    const since = this.now() - rate.repeatDays * 86_400_000;
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM offers o JOIN products p ON p.id = o.product_id
           WHERE p.item_id = ? AND o.group_id = ? AND o.created_at > ?
             AND o.status IN ('pending_approval','queued','sending','sent') LIMIT 1`,
        )
        .get(itemId, groupId, since),
    );
  }

  private sentToday(groupId: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM offers WHERE group_id = ? AND status = 'sent' AND sent_at >= ?")
      .get(groupId, saoPauloDayStart(this.now())) as { n: number };
    return row.n;
  }

  private groupOpen(group: GroupRow, settings: Settings): boolean {
    return insideWindow(saoPauloClock(this.now()), group.window_start ?? settings.windowStart, group.window_end ?? settings.windowEnd);
  }

  private acceptable(p: ShopeeProduct, s: Settings, group: GroupRow): boolean {
    return (
      p.commissionRate >= group.min_commission_rate &&
      (p.price * p.commissionRate) / 100 >= group.min_commission_value &&
      p.rating >= s.minRating &&
      p.discountRate >= s.minDiscount &&
      p.price >= s.minPrice &&
      (s.maxPrice <= 0 || p.price <= s.maxPrice) &&
      allowedImage(p.imageUrl) &&
      p.productLink.length > 0
    );
  }

  /** Garimpa e abastece a fila dos grupos automáticos. Devolve quantas ofertas criou. */
  async collect(): Promise<number> {
    const settings = getSettings(this.db);
    if (!settings.autoMode || !this.shopee.configured()) return 0;
    const rate = activeRate(settings);
    const groups = this.db
      .prepare(
        `SELECT g.* FROM groups g
         WHERE g.active = 1 AND g.auto = 1 AND EXISTS (
           SELECT 1 FROM group_categories gc JOIN categories c ON c.id = gc.category_id
           WHERE gc.group_id = g.id AND c.active = 1
         )`,
      )
      .all() as unknown as GroupRow[];
    let created = 0;
    for (const group of groups) {
      if (!this.groupOpen(group, settings) || this.sentToday(group.id) >= rate.maxPerDay) continue;
      const waiting = this.db
        .prepare("SELECT COUNT(*) AS n FROM offers WHERE group_id = ? AND status IN ('queued','pending_approval')")
        .get(group.id) as { n: number };
      if (waiting.n >= QUEUE_TARGET) continue;
      try {
        const categories = this.db
          .prepare(
            `SELECT c.id, c.keywords FROM categories c JOIN group_categories gc ON gc.category_id = c.id
             WHERE gc.group_id = ? AND c.active = 1`,
          )
          .all(group.id) as unknown as { id: number; keywords: string }[];
        const wantsCommission = group.min_commission_value > 0 || group.min_commission_rate > 0;
        // Com várias categorias, sorteia a ordem e tenta até 3 antes de esperar o próximo ciclo.
        const shuffled = categories.map((c) => ({ c, order: this.random() })).sort((a, b) => a.order - b.order).map(({ c }) => c);
        for (const category of shuffled.slice(0, 3)) {
          const keywords = JSON.parse(category.keywords) as string[];
          const keyword = keywords[Math.floor(this.random() * keywords.length)];
          if (!keyword) continue;
          const found = await this.shopee.search({ keyword, sortType: wantsCommission || this.random() >= 0.5 ? 5 : 2, limit: 30 });
          const best = found
            .filter((p) => this.acceptable(p, settings, group) && !this.recentlyOffered(p.itemId, group.id, rate))
            .sort((a, b) => this.score(b) - this.score(a))[0];
          if (!best) continue;
          await this.createOffer(best, group, "auto", PRIORITY.normal, "auto", category.id);
          created += 1;
          break;
        }
      } catch (error) {
        log(this.db, "error", `Garimpo do grupo ${group.name}: ${(error as Error).message}`, this.now());
      }
    }
    return created;
  }

  private score(p: ShopeeProduct): number {
    return p.price * p.commissionRate * Math.log10(p.sales + 10) * (1 + p.discountRate / 100);
  }

  private trackHealth(): boolean {
    const { state } = this.whatsapp.status();
    if (state !== this.lastState) {
      const text = { open: "conectado", qr: "aguardando QR Code", connecting: "conectando", disconnected: "desconectado" }[state];
      log(this.db, state === "disconnected" ? "warn" : "info", `WhatsApp: ${text}`, this.now());
      this.lastState = state;
    }
    return state === "open";
  }

  private applyCooldown(rate: Rate): void {
    const jitter = this.between(rate.jitterMin, rate.jitterMax) * 1000;
    this.nextNumberAt = this.now() + 60_000 / rate.maxPerMinute + jitter;
  }

  /** Executa no máximo um envio por chamada, sempre respeitando o limite do número. */
  async tick(): Promise<"idle" | "sent" | "approval" | "offline" | "cooldown"> {
    if (this.ticking) return "idle";
    this.ticking = true;
    try {
      this.expireOld();
      if (!this.trackHealth()) return "offline";
      if (this.now() < this.nextNumberAt) return "cooldown";
      const settings = getSettings(this.db);
      const rate = activeRate(settings);
      if (await this.notifyApproval(settings, rate)) return "approval";
      const offer = this.nextOffer(settings, rate);
      if (!offer) return "idle";
      if (this.couponClosed(offer)) {
        this.db.prepare("UPDATE offers SET status = 'expired', error = 'Cupom vencido ou desativado antes do envio' WHERE id = ?").run(offer.id);
        return "idle";
      }
      await this.send(offer, rate);
      return "sent";
    } finally {
      this.ticking = false;
    }
  }

  private couponClosed(offer: OfferRow): boolean {
    if (offer.coupon_id === null) return false;
    const coupon = this.db.prepare("SELECT * FROM coupons WHERE id = ?").get(offer.coupon_id) as CouponRow | undefined;
    return !coupon || !isOpen(coupon, this.now());
  }

  private expireOld(): void {
    this.db
      .prepare("UPDATE offers SET status = 'expired' WHERE status IN ('queued','pending_approval') AND created_at < ?")
      .run(this.now() - OFFER_TTL);
  }

  private nextOffer(settings: Settings, rate: Rate): OfferRow | undefined {
    const rows = this.db
      .prepare(
        `SELECT o.id, o.product_id, o.group_id, o.priority, o.text, o.attempts, o.coupon_id, p.image_url, g.jid
         FROM offers o JOIN products p ON p.id = o.product_id JOIN groups g ON g.id = o.group_id
         WHERE o.status = 'queued' AND g.active = 1 ORDER BY o.priority DESC, o.id ASC LIMIT 200`,
      )
      .all() as unknown as OfferRow[];
    return rows.find((row) => {
      const group = this.groupById(row.group_id);
      if (!group || !this.groupOpen(group, settings)) return false;
      if (row.priority >= PRIORITY.bypass) return true;
      return group.next_send_at <= this.now() && this.sentToday(group.id) < rate.maxPerDay;
    });
  }

  private async send(offer: OfferRow, rate: Rate): Promise<void> {
    this.db.prepare("UPDATE offers SET status = 'sending', attempts = attempts + 1 WHERE id = ?").run(offer.id);
    this.applyCooldown(rate);
    try {
      await this.whatsapp.sendImage(offer.jid, offer.image_url, offer.text);
      const gap = this.between(rate.groupIntervalMin, rate.groupIntervalMax) * 60_000;
      this.db.prepare("UPDATE offers SET status = 'sent', sent_at = ?, error = NULL WHERE id = ?").run(this.now(), offer.id);
      this.db.prepare("UPDATE groups SET next_send_at = ? WHERE id = ?").run(this.now() + gap, offer.group_id);
    } catch (error) {
      const message = (error as Error).message.slice(0, 300);
      const status = offer.attempts + 1 >= 3 ? "failed" : "queued";
      this.db.prepare("UPDATE offers SET status = ?, error = ? WHERE id = ?").run(status, message, offer.id);
      log(this.db, "error", `Envio da oferta ${offer.id}: ${message}`, this.now());
    }
  }

  private async notifyApproval(settings: Settings, rate: Rate): Promise<boolean> {
    if (!settings.approverNumber) return false;
    const row = this.db
      .prepare(
        `SELECT o.id, o.text, p.image_url, g.name FROM offers o JOIN products p ON p.id = o.product_id JOIN groups g ON g.id = o.group_id
         WHERE o.status = 'pending_approval' AND o.approval_notified = 0 ORDER BY o.priority DESC, o.id ASC LIMIT 1`,
      )
      .get() as { id: number; text: string; image_url: string; name: string } | undefined;
    if (!row) return false;
    const caption = `Aprovar para o grupo ${row.name}?\n\n${row.text}\n\nResponda: ok ${row.id} ou não ${row.id}`;
    this.db.prepare("UPDATE offers SET approval_notified = 1 WHERE id = ?").run(row.id);
    this.applyCooldown(rate);
    try {
      await this.whatsapp.sendImage(`${settings.approverNumber}@s.whatsapp.net`, row.image_url, caption);
    } catch (error) {
      this.db.prepare("UPDATE offers SET approval_notified = 0 WHERE id = ?").run(row.id);
      log(this.db, "error", `Aviso de aprovação ${row.id}: ${(error as Error).message}`, this.now());
    }
    return true;
  }

  decide(offerId: number, approved: boolean): boolean {
    const result = this.db
      .prepare("UPDATE offers SET status = ? WHERE id = ? AND status = 'pending_approval'")
      .run(approved ? "queued" : "rejected", offerId);
    return result.changes === 1;
  }

  async handleInbound({ from, text }: InboundMessage): Promise<void> {
    const { approverNumber } = getSettings(this.db);
    if (!approverNumber || !sameBrazilNumber(from, approverNumber)) return;
    const match = text.trim().match(/^(ok|sim|aprovar|1|n[aã]o|rejeitar|2)(?:\s+#?(\d+))?$/i);
    if (!match) return;
    const approved = /^(ok|sim|aprovar|1)$/i.test(match[1]!);
    const target = match[2]
      ? Number(match[2])
      : (
          this.db
            .prepare("SELECT id FROM offers WHERE status = 'pending_approval' AND approval_notified = 1 ORDER BY id LIMIT 1")
            .get() as { id: number } | undefined
        )?.id;
    if (!target || !this.decide(target, approved)) return;
    this.nextNumberAt = Math.max(this.nextNumberAt, this.now() + 15_000);
    try {
      await this.whatsapp.sendText(from, approved ? `Oferta ${target} aprovada e na fila.` : `Oferta ${target} descartada.`);
    } catch (error) {
      log(this.db, "warn", `Confirmação de aprovação: ${(error as Error).message}`, this.now());
    }
  }

  recordGroupEvent(event: GroupEvent): void {
    const group = this.db.prepare("SELECT id FROM groups WHERE jid = ?").get(event.groupJid) as { id: number } | undefined;
    if (!group) return;
    const insert = this.db.prepare("INSERT INTO group_events (group_id, participant_hash, action, ts) VALUES (?, ?, ?, ?)");
    for (const participant of event.participants) {
      const hash = createHmac("sha256", this.secret).update(participant).digest("hex").slice(0, 32);
      insert.run(group.id, hash, event.action, Math.floor(this.now() / 1000));
    }
  }

  /** Importa os pedidos da Shopee e liga cada um ao grupo e à categoria pelos sub IDs. */
  async syncConversions(days = 90): Promise<number> {
    if (!this.shopee.configured()) return 0;
    const end = Math.floor(this.now() / 1000);
    const items = await this.shopee.conversions(end - days * 86_400, end);
    const groupBy = this.db.prepare("SELECT id FROM groups WHERE code = ?");
    const categoryBy = this.db.prepare("SELECT id FROM categories WHERE code = ?");
    const upsert = this.db.prepare(
      `INSERT INTO conversions (key, order_id, item_id, item_name, status, gmv, commission, purchase_time, group_id, category_id, origin, offer_id, raw_sub)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET status = excluded.status, gmv = excluded.gmv, commission = excluded.commission`,
    );
    for (const item of items) {
      const [groupCode = "", categoryCode = "", origin = "", , offer = ""] = item.utmContent.split("-");
      const group = groupBy.get(groupCode) as { id: number } | undefined;
      const category = categoryBy.get(categoryCode) as { id: number } | undefined;
      const offerId = /^\d+$/.test(offer) ? Number(offer) : null;
      upsert.run(
        item.key, item.orderId, item.itemId, item.itemName, item.status, item.gmv, item.commission, item.purchaseTime,
        group?.id ?? null, category?.id ?? null, origin === "auto" || origin === "manual" ? origin : null, offerId, item.utmContent,
      );
    }
    log(this.db, "info", `Shopee: ${items.length} itens de pedido sincronizados`, this.now());
    return items.length;
  }
}
