import { openDb, seedCategories } from "../server/db.ts";
import type { Db } from "../server/db.ts";
import { Engine } from "../server/engine.ts";
import type { GroupRow } from "../server/engine.ts";
import type { ConversionItem, SearchInput, ShopeeApi, ShopeeProduct } from "../server/shopee.ts";
import type { GroupEvent, InboundMessage, WaGroup, WhatsAppProvider, WhatsAppStatus } from "../server/whatsapp.ts";
import type { HeadlineWriter, OfferCopy } from "../server/writer.ts";

export const SECRET = "x".repeat(40);

export function product(id: number, overrides: Partial<ShopeeProduct> = {}): ShopeeProduct {
  return {
    itemId: String(id),
    name: `Produto ${id}`,
    imageUrl: `https://down-br.img.susercontent.com/file/${id}`,
    productLink: `https://shopee.com.br/produto-i.1.${id}`,
    price: 49.9,
    discountRate: 30,
    commissionRate: 8,
    rating: 4.8,
    sales: 500,
    shopName: "Loja",
    officialStore: false,
    ...overrides,
  };
}

export class FakeShopee implements ShopeeApi {
  products: ShopeeProduct[] = [];
  items: ConversionItem[] = [];
  subIds: string[][] = [];
  searches: SearchInput[] = [];
  configured(): boolean {
    return true;
  }
  async search(input: SearchInput): Promise<ShopeeProduct[]> {
    this.searches.push(input);
    return this.products;
  }
  async shortLink(_url: string, subIds: string[]): Promise<string> {
    this.subIds.push(subIds);
    return `https://s.shopee.com.br/${subIds[4]}`;
  }
  async conversions(): Promise<ConversionItem[]> {
    return this.items;
  }
}

export class FakeWhatsApp implements WhatsAppProvider {
  state: WhatsAppStatus = { state: "open" };
  sent: { jid: string; image?: string; text: string }[] = [];
  failNext = 0;
  groupHandler: (event: GroupEvent) => void = () => {};
  messageHandler: (message: InboundMessage) => void = () => {};
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  status(): WhatsAppStatus {
    return this.state;
  }
  async sendImage(jid: string, image: string, text: string): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("falhou");
    }
    this.sent.push({ jid, image, text });
  }
  async sendText(jid: string, text: string): Promise<void> {
    this.sent.push({ jid, text });
  }
  async listGroups(): Promise<WaGroup[]> {
    return [{ jid: "1@g.us", name: "Grupo", size: 10 }];
  }
  onGroupEvent(handler: (event: GroupEvent) => void): void {
    this.groupHandler = handler;
  }
  onMessage(handler: (message: InboundMessage) => void): void {
    this.messageHandler = handler;
  }
}

export class FakeWriter implements HeadlineWriter {
  fail = false;
  configured(): boolean {
    return true;
  }
  async headline(): Promise<OfferCopy | null> {
    if (this.fail) throw new Error("sem IA");
    return { headline: "Chamada da IA", title: "Produto curto" };
  }
}

export interface Harness {
  db: Db;
  shopee: FakeShopee;
  whatsapp: FakeWhatsApp;
  writer: FakeWriter;
  engine: Engine;
  clock: { now: number };
  addGroup(name: string, options?: { approval?: boolean; category?: string }): GroupRow;
}

export function harness(start = "2026-11-09T12:00:00-03:00"): Harness {
  const db = openDb(":memory:");
  seedCategories(db);
  const shopee = new FakeShopee();
  const whatsapp = new FakeWhatsApp();
  const writer = new FakeWriter();
  const clock = { now: Date.parse(start) };
  const engine = new Engine({ db, shopee, writer, whatsapp, secret: SECRET, now: () => clock.now, random: () => 0.5 });
  const addGroup: Harness["addGroup"] = (name, options = {}) => {
    const category = db.prepare("SELECT id FROM categories WHERE code = ?").get(options.category ?? "casa") as { id: number };
    db.prepare("UPDATE categories SET active = 1 WHERE id = ?").run(category.id);
    const group = db
      .prepare("INSERT INTO groups (jid, name, code, approval) VALUES (?, ?, ?, ?) RETURNING *")
      .get(`${name}@g.us`, name, name, options.approval ? 1 : 0) as unknown as GroupRow;
    db.prepare("INSERT INTO group_categories (group_id, category_id) VALUES (?, ?)").run(group.id, category.id);
    return group;
  };
  return { db, shopee, whatsapp, writer, engine, clock, addGroup };
}

export const MINUTE = 60_000;
