import { describe, expect, it } from "vitest";
import { Engine, PRIORITY, sameBrazilNumber } from "../server/engine.ts";
import { DEFAULT_SETTINGS, saveSettings } from "../server/settings.ts";
import { cleanHeadline, parseCopy, renderOffer } from "../server/writer.ts";
import { harness, MINUTE, product, SECRET } from "./helpers.ts";

const status = (h: ReturnType<typeof harness>, id: number) =>
  (h.db.prepare("SELECT status FROM offers WHERE id = ?").get(id) as { status: string }).status;

describe("fila anti-ban", () => {
  it("respeita o limite do número e o intervalo do grupo", async () => {
    const h = harness();
    const a = h.addGroup("a");
    const b = h.addGroup("b");
    await h.engine.createOffer(product(1), a, "auto", PRIORITY.normal);
    await h.engine.createOffer(product(2), a, "auto", PRIORITY.normal);
    await h.engine.createOffer(product(3), b, "auto", PRIORITY.normal);

    expect(await h.engine.tick()).toBe("sent");
    expect(await h.engine.tick()).toBe("cooldown");
    expect(h.whatsapp.sent).toHaveLength(1);
    h.clock.now += 59_000;
    expect(await h.engine.tick()).toBe("cooldown");
    h.clock.now += MINUTE + 75_000; // 60s + jitter do preset conservador
    expect(await h.engine.tick()).toBe("sent");
    expect(h.whatsapp.sent[1]?.jid).toBe("b@g.us");

    h.clock.now += 3 * MINUTE;
    expect(await h.engine.tick()).toBe("idle");
    h.clock.now += 30 * MINUTE;
    expect(await h.engine.tick()).toBe("sent");
    expect(h.whatsapp.sent[2]?.jid).toBe("a@g.us");
  });

  it("não envia fora da janela de horário, nem no modo furar a fila", async () => {
    const h = harness("2026-11-09T22:00:00-03:00");
    const group = h.addGroup("a");
    await h.engine.createOffer(product(1), group, "manual", PRIORITY.bypass);
    expect(await h.engine.tick()).toBe("idle");
    expect(h.whatsapp.sent).toHaveLength(0);
  });

  it("manual passa na frente; furar a fila ignora o intervalo do grupo, mas não o limite do número", async () => {
    const h = harness();
    const group = h.addGroup("a");
    await h.engine.createOffer(product(1), group, "auto", PRIORITY.normal);
    const manual = await h.engine.createOffer(product(2), group, "manual", PRIORITY.manual);
    await h.engine.tick();
    expect(status(h, manual)).toBe("sent");

    const bypass = await h.engine.createOffer(product(3), group, "manual", PRIORITY.bypass);
    expect(await h.engine.tick()).toBe("cooldown");
    h.clock.now += 3 * MINUTE;
    expect(await h.engine.tick()).toBe("sent");
    expect(status(h, bypass)).toBe("sent");
  });

  it("respeita o teto diário do grupo", async () => {
    const h = harness();
    saveSettings(h.db, { ...DEFAULT_SETTINGS, preset: "personalizado", custom: { ...DEFAULT_SETTINGS.custom, maxPerDay: 1 } });
    const group = h.addGroup("a");
    await h.engine.createOffer(product(1), group, "auto", PRIORITY.normal);
    await h.engine.createOffer(product(2), group, "auto", PRIORITY.normal);
    await h.engine.tick();
    h.clock.now += 60 * MINUTE;
    expect(await h.engine.tick()).toBe("idle");
    expect(h.whatsapp.sent).toHaveLength(1);
  });

  it("não envia com o WhatsApp desconectado e registra o alerta", async () => {
    const h = harness();
    await h.engine.createOffer(product(1), h.addGroup("a"), "auto", PRIORITY.normal);
    h.whatsapp.state = { state: "disconnected" };
    expect(await h.engine.tick()).toBe("offline");
    const row = h.db.prepare("SELECT message FROM logs WHERE level = 'warn'").get() as { message: string };
    expect(row.message).toContain("desconectado");
  });

  it("tenta de novo até 3 vezes e depois marca como falha", async () => {
    const h = harness();
    const id = await h.engine.createOffer(product(1), h.addGroup("a"), "auto", PRIORITY.normal);
    h.whatsapp.failNext = 3;
    for (let i = 0; i < 3; i++) {
      await h.engine.tick();
      h.clock.now += 5 * MINUTE;
    }
    expect(status(h, id)).toBe("failed");
  });

  it("não reenvia oferta interrompida ao reiniciar", async () => {
    const h = harness();
    const id = await h.engine.createOffer(product(1), h.addGroup("a"), "auto", PRIORITY.normal);
    h.db.prepare("UPDATE offers SET status = 'sending' WHERE id = ?").run(id);
    new Engine({ db: h.db, shopee: h.shopee, writer: h.writer, whatsapp: h.whatsapp, secret: SECRET });
    expect(status(h, id)).toBe("failed");
  });

  it("expira ofertas com mais de 24 horas", async () => {
    const h = harness();
    const id = await h.engine.createOffer(product(1), h.addGroup("a"), "auto", PRIORITY.normal);
    h.clock.now += 25 * 60 * MINUTE;
    await h.engine.tick();
    expect(status(h, id)).toBe("expired");
  });
});

describe("garimpo", () => {
  it("só roda com o modo automático ligado", async () => {
    const h = harness();
    h.addGroup("a");
    h.shopee.products = [product(1)];
    expect(await h.engine.collect()).toBe(0);
    expect(h.shopee.searches).toHaveLength(0);
  });

  it("aplica filtros e não repete produto dentro do período", async () => {
    const h = harness();
    saveSettings(h.db, { ...DEFAULT_SETTINGS, autoMode: true });
    h.addGroup("a");
    h.shopee.products = [
      product(1, { rating: 3 }),
      product(2, { discountRate: 0 }),
      product(3, { imageUrl: "http://169.254.169.254/x" }),
      product(4),
    ];
    expect(await h.engine.collect()).toBe(1);
    const offer = h.db.prepare("SELECT p.item_id FROM offers o JOIN products p ON p.id = o.product_id").all() as { item_id: string }[];
    expect(offer).toEqual([{ item_id: "4" }]);
    expect(await h.engine.collect()).toBe(0);
  });
});

describe("aprovação", () => {
  async function pending() {
    const h = harness();
    saveSettings(h.db, { ...DEFAULT_SETTINGS, approverNumber: "5571999998888" });
    const id = await h.engine.createOffer(product(1), h.addGroup("a", { approval: true }), "auto", PRIORITY.normal);
    return { h, id };
  }

  it("manda prévia para o WhatsApp pessoal e só aceita resposta desse número", async () => {
    const { h, id } = await pending();
    expect(status(h, id)).toBe("pending_approval");
    expect(await h.engine.tick()).toBe("approval");
    expect(h.whatsapp.sent[0]?.jid).toBe("5571999998888@s.whatsapp.net");

    await h.engine.handleInbound({ from: "5511911112222@s.whatsapp.net", text: `ok ${id}` });
    expect(status(h, id)).toBe("pending_approval");

    await h.engine.handleInbound({ from: "557199998888@s.whatsapp.net", text: `ok ${id}` });
    expect(status(h, id)).toBe("queued");
  });

  it("descarta quando a resposta é não", async () => {
    const { h, id } = await pending();
    await h.engine.tick();
    await h.engine.handleInbound({ from: "5571999998888@s.whatsapp.net", text: "não" });
    expect(status(h, id)).toBe("rejected");
  });

  it("completa o 55 quando o número foi salvo só com DDD", async () => {
    const h = harness();
    saveSettings(h.db, { ...DEFAULT_SETTINGS, approverNumber: "71999998888" });
    const id = await h.engine.createOffer(product(1), h.addGroup("a", { approval: true }), "auto", PRIORITY.normal);
    await h.engine.tick();
    expect(h.whatsapp.sent[0]?.jid).toBe("5571999998888@s.whatsapp.net");
    await h.engine.handleInbound({ from: "5571999998888@s.whatsapp.net", text: `ok ${id}` });
    expect(status(h, id)).toBe("queued");
  });

  it("compara números brasileiros com e sem o nono dígito", () => {
    expect(sameBrazilNumber("5571999998888", "557199998888@s.whatsapp.net")).toBe(true);
    expect(sameBrazilNumber("5571999998888", "5571999998887")).toBe(false);
  });
});

describe("cupons", () => {
  type Rules = Partial<{ code: string; kind: string; value: number; min: number; max: number; category: number | null; expires: string | null; active: number }>;
  const add = (h: ReturnType<typeof harness>, r: Rules = {}) =>
    (h.db
      .prepare("INSERT INTO coupons (code, kind, value, min_price, max_discount, category_id, expires_on, active, created_at) VALUES (?,?,?,?,?,?,?,?,0) RETURNING id")
      .get(r.code ?? "CUPOM10", r.kind ?? "percent", r.value ?? 10, r.min ?? 0, r.max ?? 0, r.category ?? null, r.expires ?? null, r.active ?? 1) as { id: number }).id;
  const text = (h: ReturnType<typeof harness>, id: number) => (h.db.prepare("SELECT text FROM offers WHERE id = ?").get(id) as { text: string }).text;

  it("aplica o melhor cupom e mostra o código com o preço final", async () => {
    const h = harness();
    add(h, { code: "POUCO", value: 5 });
    add(h, { code: "MELHOR", kind: "fixed", value: 20 });
    const id = await h.engine.createOffer(product(1, { price: 100, discountRate: 0 }), h.addGroup("a"), "auto", PRIORITY.normal);
    expect(text(h, id)).toContain("de ~R$ 100~\n💸 por *R$ 80*\n🎟️ cupom: *MELHOR*");
  });

  it("respeita compra mínima, teto, categoria e validade", async () => {
    const h = harness();
    const group = h.addGroup("a");
    add(h, { code: "MINIMO", value: 50, min: 500 });
    add(h, { code: "VENCIDO", value: 60, expires: "2026-11-08" });
    add(h, { code: "OUTRA", value: 70, category: 24 });
    add(h, { code: "OFF", value: 80, active: 0 });
    add(h, { code: "TETO", value: 50, max: 5 });
    const id = await h.engine.createOffer(product(1, { price: 100 }), group, "auto", PRIORITY.normal);
    expect(text(h, id)).toContain("por *R$ 95*");
    expect(text(h, id)).toContain("*TETO*");
  });

  it("vale até o fim do dia da validade em São Paulo", async () => {
    const h = harness("2026-11-09T23:30:00-03:00");
    add(h, { code: "HOJE", expires: "2026-11-09" });
    const id = await h.engine.createOffer(product(1, { price: 100 }), h.addGroup("a"), "auto", PRIORITY.normal);
    expect(text(h, id)).toContain("*HOJE*");
  });

  it("permite enviar sem cupom e explica quando o escolhido não vale", async () => {
    const h = harness();
    const group = h.addGroup("a");
    const coupon = add(h, { code: "MINIMO", min: 500 });
    const id = await h.engine.createOffer(product(1, { price: 100 }), group, "manual", PRIORITY.manual, "none");
    expect(text(h, id)).not.toContain("cupom:");
    await expect(h.engine.createOffer(product(2, { price: 100 }), group, "manual", PRIORITY.manual, coupon)).rejects.toThrow("MINIMO exige compra mínima");
  });

  it("mostra o código mesmo em layout sem a variável de cupom", async () => {
    const h = harness();
    add(h, { code: "ANTIGO" });
    saveSettings(h.db, { ...DEFAULT_SETTINGS, layout: "R$ {preco}\nCompre: {link}" });
    const id = await h.engine.createOffer(product(1, { price: 100 }), h.addGroup("a"), "auto", PRIORITY.normal);
    expect(text(h, id)).toContain("🎟️ cupom: *ANTIGO*\nCompre:");
  });

  it("não envia oferta cujo cupom venceu ou foi desativado depois", async () => {
    const h = harness();
    const coupon = add(h);
    const id = await h.engine.createOffer(product(1), h.addGroup("a"), "auto", PRIORITY.normal);
    h.db.prepare("UPDATE coupons SET active = 0 WHERE id = ?").run(coupon);
    await h.engine.tick();
    expect(status(h, id)).toBe("expired");
    expect(h.whatsapp.sent).toHaveLength(0);
  });
});

describe("mensagem", () => {
  it("usa sub IDs sem hífen e a IA não controla preço nem link", async () => {
    const h = harness();
    const id = await h.engine.createOffer(product(1), h.addGroup("casa01"), "manual", PRIORITY.manual);
    expect(h.shopee.subIds[0]).toEqual(["casa01", "casa", "manual", "20261109", String(id)]);
    h.shopee.subIds[0]!.forEach((sub) => expect(sub).toMatch(/^[a-z0-9]+$/));
    const { text } = h.db.prepare("SELECT text FROM offers WHERE id = ?").get(id) as { text: string };
    expect(text).toBe(`*CHAMADA DA IA*\n\n*Produto curto*\n\nde ~R$ 71~\n💸 por *R$ 49,90*\n\nCompre aqui: https://s.shopee.com.br/${id}`);
  });

  it("segue sem IA quando ela falha", async () => {
    const h = harness();
    h.writer.fail = true;
    const id = await h.engine.createOffer(product(1), h.addGroup("a"), "auto", PRIORITY.normal);
    expect(status(h, id)).toBe("queued");
  });

  it("limpa links e formatação do texto da IA", () => {
    expect(cleanHeadline('Veja https://malicioso.com "agora"\n*já*')).toBe("Veja agora já");
    expect(cleanHeadline("  ")).toBeNull();
  });

  it("nome de produto não injeta variáveis no layout", () => {
    const text = renderOffer("{titulo} {link}", product(1, { name: "{link} {preco}" }), { headline: "x", title: null }, "https://l");
    expect(text).toBe("{link} {preco} https://l");
  });

  it("omite o preço antigo sem desconto e encurta nomes longos", () => {
    const name = "Fritadeira Elétrica sem Óleo Air Fryer 12 em 1 WAP 1800W Barbecue 10L digital Preta";
    const text = renderOffer(DEFAULT_SETTINGS.layout, product(1, { name, discountRate: 0, price: 310 }), { headline: "Oferta", title: null }, "https://l");
    expect(text).not.toContain("de ~");
    expect(text).toContain("💸 por *R$ 310*");
    expect(text).toContain("*Fritadeira Elétrica sem Óleo Air Fryer 12 em 1 WAP 1800W*");
    expect(text).not.toMatch(/\n{3}/);
  });

  it("recusa título da IA que inventa informação", () => {
    expect(parseCopy("Chamada boa\nAir Fryer WAP 10L", "Fritadeira Air Fryer 12 em 1 WAP 10L")?.title).toBe("Air Fryer WAP 10L");
    expect(parseCopy("Chamada boa\nGeladeira Samsung Inverter", "Fritadeira Air Fryer WAP")?.title).toBeNull();
  });
});

describe("métricas", () => {
  it("liga as vendas ao grupo e à categoria pelos sub IDs", async () => {
    const h = harness();
    const group = h.addGroup("casa01");
    h.shopee.items = [
      {
        key: "c:o:i", orderId: "o", itemId: "i", itemName: "Produto", status: "pending",
        gmv: 100, commission: 8, purchaseTime: 1_790_000_000, utmContent: "casa01-casa-auto-20261109-7",
      },
    ];
    expect(await h.engine.syncConversions()).toBe(1);
    const row = h.db.prepare("SELECT group_id, origin, offer_id FROM conversions").get() as Record<string, unknown>;
    expect(row).toEqual({ group_id: group.id, origin: "auto", offer_id: 7 });

    h.shopee.items[0]!.status = "validated";
    await h.engine.syncConversions();
    expect(h.db.prepare("SELECT status FROM conversions").get()).toEqual({ status: "validated" });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM conversions").get()).toEqual({ n: 1 });
  });

  it("guarda entradas e saídas sem o telefone do participante", () => {
    const h = harness();
    h.addGroup("a");
    h.whatsapp.groupHandler({ groupJid: "a@g.us", participants: ["5571999998888@s.whatsapp.net"], action: "add" });
    const row = h.db.prepare("SELECT participant_hash, action FROM group_events").get() as { participant_hash: string; action: string };
    expect(row.action).toBe("add");
    expect(row.participant_hash).not.toContain("5571");
  });
});

describe("grupos com várias categorias e comissão mínima", () => {
  const prepare = () => {
    const h = harness();
    saveSettings(h.db, { ...DEFAULT_SETTINGS, autoMode: true });
    const group = h.addGroup("a");
    h.db.exec("UPDATE categories SET active = 1 WHERE code = 'suplementos'");
    h.db.prepare("INSERT INTO group_categories (group_id, category_id) SELECT ?, id FROM categories WHERE code = 'suplementos'").run(group.id);
    return { h, group };
  };

  it("garimpa nas categorias do grupo e registra a categoria usada", async () => {
    const { h } = prepare();
    h.shopee.products = [product(1)];
    expect(await h.engine.collect()).toBe(1);
    expect(["casa", "suplementos"]).toContain(h.shopee.subIds[0]?.[1]);
  });

  it("tenta outra categoria quando a primeira não tem produto", async () => {
    const { h } = prepare();
    const search = h.shopee.search.bind(h.shopee);
    let calls = 0;
    h.shopee.search = async (input) => (++calls === 1 ? [] : search(input));
    h.shopee.products = [product(1)];
    expect(await h.engine.collect()).toBe(1);
    expect(calls).toBe(2);
  });

  it("ignora categoria desativada e grupo sem categoria ativa", async () => {
    const { h } = prepare();
    h.db.exec("UPDATE categories SET active = 0");
    h.shopee.products = [product(1)];
    expect(await h.engine.collect()).toBe(0);
    expect(h.shopee.searches).toHaveLength(0);
  });

  it("escolhe só produtos com a comissão mínima do grupo e prioriza maior comissão", async () => {
    const { h, group } = prepare();
    h.db.prepare("UPDATE groups SET min_commission_value = 10, min_commission_rate = 15 WHERE id = ?").run(group.id);
    h.shopee.products = [
      product(1, { price: 50, commissionRate: 10 }),
      product(2, { price: 50, commissionRate: 15 }),
      product(3, { price: 100, commissionRate: 15 }),
    ];
    expect(await h.engine.collect()).toBe(1);
    expect(h.shopee.searches[0]?.sortType).toBe(5);
    expect(h.db.prepare("SELECT p.item_id FROM offers o JOIN products p ON p.id = o.product_id").all()).toEqual([{ item_id: "3" }]);
  });

  it("no envio manual com várias categorias usa a escolhida", async () => {
    const { h, group } = prepare();
    const category = (h.db.prepare("SELECT id FROM categories WHERE code = 'suplementos'").get() as { id: number }).id;
    await h.engine.createOffer(product(1), group, "manual", PRIORITY.manual, "none", category);
    await h.engine.createOffer(product(2), group, "manual", PRIORITY.manual, "none", null);
    expect(h.shopee.subIds.map((s) => s[1])).toEqual(["suplementos", "semcategoria"]);
  });
});

describe("loja oficial", () => {
  const copy = { headline: "Oferta", title: "Produto" };

  it("mostra a loja só quando é oficial", () => {
    const official = renderOffer(DEFAULT_SETTINGS.layout, product(1, { shopName: "Nike Oficial", officialStore: true }), copy, "https://l");
    expect(official).toContain("Loja oficial: Nike Oficial\nCompre aqui: https://l");
    const common = renderOffer(DEFAULT_SETTINGS.layout, product(1, { shopName: "Lojinha", officialStore: false }), copy, "https://l");
    expect(common).not.toContain("Lojinha");
    expect(common).not.toContain("Loja oficial");
    expect(common).toMatch(/\*R\$ 49,90\*\n\nCompre aqui: https:\/\/l$/);
  });
});
