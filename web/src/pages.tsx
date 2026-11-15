import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Check, CircleAlert, RefreshCw, Search, X } from "lucide-react";
import { api, brl, commissionOf, dateTime, number, useLoad } from "./api.ts";
import type { AppStatus, Category, Coupon, Dashboard, Group, IntegrationSection, MetricRow, Offer, Product, Rate, Settings } from "./api.ts";
import { BarChart } from "./charts.tsx";
import { Button, Card, Empty, Field, LoadState, PageHead, Toggle, useToast } from "./ui.tsx";

export type PageId = "dashboard" | "queue" | "send" | "coupons" | "groups" | "categories" | "settings";

interface PageProps {
  status: AppStatus | null;
  reloadStatus: () => Promise<void>;
  go: (page: PageId) => void;
}

const SP_OFFSET = 3 * 3_600_000;
const isoDay = (ms: number) => new Date(ms - SP_OFFSET).toISOString().slice(0, 10);

function Setup({ status, go }: PageProps) {
  const groups = useLoad<Group[]>("/groups");
  if (!status) return null;
  const steps = [
    { done: status.shopee, text: "Preencher as chaves da Shopee em Ajustes", page: "settings" as const },
    { done: status.whatsapp.state === "open", text: "Conectar o WhatsApp pelo QR Code", page: "settings" as const },
    { done: (groups.data?.length ?? 0) > 0, text: "Cadastrar um grupo e escolher a categoria", page: "groups" as const },
    { done: status.settings.autoMode, text: "Ligar o modo automático quando quiser", page: "settings" as const },
  ];
  if (steps.every((s) => s.done)) return null;
  return (
    <Card title="Primeiros passos">
      <ul className="steps">
        {steps.map((step) => (
          <li key={step.text} className={step.done ? "done" : ""}>
            {step.done ? <Check size={17} aria-label="Concluído" /> : <CircleAlert size={17} aria-label="Pendente" />}
            <span>{step.text}</span>
            {!step.done && step.page && <Button variant="ghost" onClick={() => go(step.page!)}>Abrir</Button>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

function Ranking({ title, rows, metric }: { title: string; rows: MetricRow[]; metric: "commission" | "gmv" }) {
  const max = Math.max(...rows.map((r) => r[metric]), 1);
  return (
    <Card title={title}>
      {rows.length === 0 ? (
        <Empty title="Sem vendas no período" />
      ) : (
        <div className="table-wrap">
          <table className="ranking">
            <thead><tr><th>Nome</th><th>Comissão</th><th>Vendido</th><th>Pedidos</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.name}>
                  <td>
                    <span className="rank-name" title={row.name}>{row.name}</span>
                    <span className="rank-bar"><i style={{ width: `${(row[metric] / max) * 100}%` }} /></span>
                  </td>
                  <td>{brl(row.commission)}</td>
                  <td>{brl(row.gmv)}</td>
                  <td>{number(row.orders)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

const ACCENT = "var(--chart-1)";
const METRICS = {
  commission: { label: "Comissão", format: brl },
  gmv: { label: "Valor vendido", format: brl },
  orders: { label: "Pedidos", format: number },
} as const;

export function DashboardPage(props: PageProps) {
  const toast = useToast();
  const [days, setDays] = useState(30);
  const [groupId, setGroupId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [metric, setMetric] = useState<keyof typeof METRICS>("commission");
  const [syncing, setSyncing] = useState(false);
  const groups = useLoad<Group[]>("/groups");
  const categories = useLoad<Category[]>("/categories");
  const query = useMemo(() => {
    const now = Date.now();
    const params = new URLSearchParams({ from: isoDay(now - (days - 1) * 86_400_000), to: isoDay(now) });
    if (groupId) params.set("groupId", groupId);
    if (categoryId) params.set("categoryId", categoryId);
    return params.toString();
  }, [days, groupId, categoryId]);
  const { data, error, loading, reload } = useLoad<Dashboard>(`/dashboard?${query}`);

  const sync = async () => {
    setSyncing(true);
    try {
      const result = await api<{ items: number }>("/shopee/sync", "POST");
      toast.ok(`${number(result.items)} itens de pedido atualizados`);
      await reload();
    } catch (reason) {
      toast.fail(reason);
    } finally {
      setSyncing(false);
    }
  };

  const m = METRICS[metric];
  const metricRank = metric === "gmv" ? "gmv" : "commission";

  return (
    <>
      <PageHead
        title="Resultados"
        sub="Vendas e pessoas por grupo, categoria e produto."
        action={<Button onClick={sync} busy={syncing} disabled={!props.status?.shopee}><RefreshCw size={15} aria-hidden="true" /> Atualizar vendas</Button>}
      />
      <Setup {...props} />
      <div className="filters">
        <div className="segmented" role="group" aria-label="Período">
          {[7, 30, 90].map((d) => (
            <button key={d} type="button" className={days === d ? "on" : ""} onClick={() => setDays(d)}>{d} dias</button>
          ))}
        </div>
        <select aria-label="Grupo" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          <option value="">Todos os grupos</option>
          {groups.data?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <select aria-label="Categoria" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">Todas as categorias</option>
          {categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <LoadState loading={loading && !data} error={error} onRetry={reload} />
      {data && (
        <>
          <div className="stats">
            <Stat label="Comissão" value={brl(data.totals.commission)} note={`${brl(data.totals.validated)} concluída · ${brl(data.totals.pending)} pendente`} />
            <Stat label="Valor vendido" value={brl(data.totals.gmv)} />
            <Stat label="Pedidos" value={number(data.totals.orders)} />
            <Stat label="Entraram nos grupos" value={number(data.leads.joined)} />
            <Stat label="Saíram dos grupos" value={number(data.leads.left)} note={`Saldo: ${number(data.leads.joined - data.leads.left)}`} />
          </div>
          <Card
            title="Por dia"
            action={
              <div className="segmented" role="group" aria-label="Medida">
                {(Object.keys(METRICS) as (keyof typeof METRICS)[]).map((key) => (
                  <button key={key} type="button" className={metric === key ? "on" : ""} onClick={() => setMetric(key)}>{METRICS[key].label}</button>
                ))}
              </div>
            }
          >
            {data.daily.length === 0 ? (
              <Empty title="Ainda não há vendas neste período">As vendas aparecem aqui depois que a Shopee registra os pedidos, com algumas horas de atraso.</Empty>
            ) : (
              <BarChart rows={data.daily} xKey="day" series={[{ key: metric, label: m.label, color: ACCENT }]} format={m.format} ariaLabel={`${m.label} por dia`} />
            )}
          </Card>
          <div className="grid-2">
            <Card title="Pessoas nos grupos">
              {data.leads.daily.length === 0 ? (
                <Empty title="Nenhuma entrada ou saída registrada" />
              ) : (
                <BarChart
                  rows={data.leads.daily}
                  xKey="day"
                  series={[{ key: "joined", label: "Entraram", color: "var(--chart-1)" }, { key: "left_group", label: "Saíram", color: "var(--chart-2)" }]}
                  format={number}
                  ariaLabel="Pessoas que entraram e saíram por dia"
                />
              )}
            </Card>
            <Card title="Por mês">
              {data.monthly.length === 0 ? (
                <Empty title="Sem vendas no período" />
              ) : (
                <div className="table-wrap">
                  <table className="ranking">
                    <thead><tr><th>Mês</th><th>Comissão</th><th>Vendido</th><th>Pedidos</th></tr></thead>
                    <tbody>
                      {data.monthly.map((row) => (
                        <tr key={row.month}><td>{row.month.slice(5)}/{row.month.slice(0, 4)}</td><td>{brl(row.commission)}</td><td>{brl(row.gmv)}</td><td>{number(row.orders)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
            <Ranking title="Por grupo" rows={data.byGroup} metric={metricRank} />
            <Ranking title="Por categoria" rows={data.byCategory} metric={metricRank} />
            <Ranking title="Por produto" rows={data.byProduct} metric={metricRank} />
            <Ranking title="Automático ou manual" rows={data.origin} metric={metricRank} />
          </div>
        </>
      )}
    </>
  );
}

const STATUS_TEXT: Record<string, string> = {
  pending_approval: "Aguardando aprovação", queued: "Na fila", sending: "Enviando", sent: "Enviada",
  failed: "Falhou", rejected: "Descartada", expired: "Expirada", canceled: "Cancelada",
};

export function QueuePage({ reloadStatus }: PageProps) {
  const toast = useToast();
  const [scope, setScope] = useState<"open" | "history">("open");
  const { data, error, loading, reload } = useLoad<Offer[]>(`/offers?scope=${scope}`, 8000);

  const act = async (id: number, action: "approve" | "reject" | "cancel") => {
    try {
      await api(`/offers/${id}/${action}`, "POST");
      await Promise.all([reload(), reloadStatus()]);
    } catch (reason) {
      toast.fail(reason);
    }
  };

  return (
    <>
      <PageHead
        title="Fila de envio"
        sub="O que vai sair, o que espera sua aprovação e o que já foi."
        action={
          <div className="segmented" role="group" aria-label="Visão">
            <button type="button" className={scope === "open" ? "on" : ""} onClick={() => setScope("open")}>Na fila</button>
            <button type="button" className={scope === "history" ? "on" : ""} onClick={() => setScope("history")}>Histórico</button>
          </div>
        }
      />
      <LoadState loading={loading && !data} error={error} onRetry={reload} />
      {data?.length === 0 && <Card><Empty title={scope === "open" ? "Fila vazia" : "Nada enviado ainda"}>{scope === "open" ? "As próximas ofertas aparecem aqui." : undefined}</Empty></Card>}
      <div className="offers">
        {data?.map((offer) => (
          <article key={offer.id} className="offer">
            <img src={offer.image_url} alt="" loading="lazy" />
            <div className="offer-body">
              <div className="offer-meta">
                <span className={`tag tag-${offer.status}`}>{STATUS_TEXT[offer.status] ?? offer.status}</span>
                <span>{offer.group_name}</span>
                <span>{offer.origin === "manual" ? (offer.priority > 1 ? "Manual · furou a fila" : "Manual") : "Automático"}</span>
                <span>{dateTime(offer.sent_at ?? offer.created_at)}</span>
                <span>Comissão por venda: cerca de <strong>{brl(commissionOf(offer.price, offer.commission_rate))}</strong></span>
              </div>
              <pre>{offer.text}</pre>
              {offer.error && <p className="offer-error">{offer.error}</p>}
              <div className="row">
                {offer.status === "pending_approval" && (
                  <>
                    <Button variant="primary" onClick={() => void act(offer.id, "approve")}><Check size={15} aria-hidden="true" /> Aprovar</Button>
                    <Button onClick={() => void act(offer.id, "reject")}><X size={15} aria-hidden="true" /> Descartar</Button>
                  </>
                )}
                {offer.status === "queued" && <Button variant="ghost" onClick={() => void act(offer.id, "cancel")}>Cancelar</Button>}
              </div>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

export function SendPage({ status, go }: PageProps) {
  const toast = useToast();
  const groups = useLoad<Group[]>("/groups");
  const coupons = useLoad<Coupon[]>("/coupons");
  const [coupon, setCoupon] = useState("auto");
  const categories = useLoad<Category[]>("/categories");
  const [categoryId, setCategoryId] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("vendas");
  const [results, setResults] = useState<Product[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [bypass, setBypass] = useState(false);
  const [sending, setSending] = useState("");

  const search = async (event: FormEvent) => {
    event.preventDefault();
    setSearching(true);
    try {
      setResults(await api<Product[]>(`/products/search?${new URLSearchParams({ q, sort })}`));
    } catch (reason) {
      toast.fail(reason);
    } finally {
      setSearching(false);
    }
  };

  const send = async (product: Product) => {
    setSending(product.itemId);
    try {
      const result = await api<{ failed: string[] }>("/offers/manual", "POST", { groupIds: selected, itemId: product.itemId, mode: bypass ? "bypass" : "priority", coupon: coupon === "auto" || coupon === "none" ? coupon : Number(coupon), categoryId: categoryId ? Number(categoryId) : null });
      if (result.failed.length > 0) toast.fail(new Error(`Criada em parte. Falhou: ${result.failed.join("; ")}`));
      else toast.ok("Oferta criada. Acompanhe na Fila.");
    } catch (reason) {
      toast.fail(reason);
    } finally {
      setSending("");
    }
  };

  const toggle = (id: number) => setSelected((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));

  return (
    <>
      <PageHead title="Enviar oferta" sub="Escolha um produto e mande para os grupos que quiser." />
      {status && !status.shopee && <div className="notice notice-warn">As chaves da Shopee ainda não foram preenchidas em Ajustes.</div>}
      <Card title="1. Para quais grupos?">
        {groups.data?.length === 0 ? (
          <Empty title="Nenhum grupo cadastrado"><Button variant="ghost" onClick={() => go("groups")}>Cadastrar grupo</Button></Empty>
        ) : (
          <div className="chips">
            {groups.data?.map((g) => (
              <label key={g.id} className={selected.includes(g.id) ? "chip on" : "chip"}>
                <input type="checkbox" checked={selected.includes(g.id)} onChange={() => toggle(g.id)} />{g.name}
              </label>
            ))}
          </div>
        )}
        <Field label="Cupom" hint="O preço da mensagem já sai com o desconto, e o código aparece junto.">
          <select value={coupon} onChange={(e) => setCoupon(e.target.value)}>
            <option value="auto">Melhor cupom válido, se houver</option>
            <option value="none">Sem cupom</option>
            {coupons.data?.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.code} ({couponText(c)})</option>)}
          </select>
        </Field>
        <Field label="Categoria nos relatórios" hint="Use quando o grupo tem mais de uma categoria.">
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Definir automaticamente</option>
            {categories.data?.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Toggle checked={bypass} onChange={setBypass} label="Furar a fila" hint="Ignora o intervalo do grupo. Usar sempre aumenta o risco de banimento." />
      </Card>
      <Card title="2. Qual produto?">
        <form className="search" onSubmit={search}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ex.: panela antiaderente" aria-label="Buscar produto" minLength={2} required />
          <select aria-label="Ordenar" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="vendas">Mais vendidos</option>
            <option value="comissao">Maior comissão</option>
          </select>
          <Button type="submit" variant="primary" busy={searching}><Search size={15} aria-hidden="true" /> Buscar</Button>
        </form>
        {results?.length === 0 && <Empty title="Nenhum produto encontrado" />}
        <div className="products">
          {results?.map((p) => (
            <article key={p.itemId} className="product">
              <img src={p.imageUrl} alt="" loading="lazy" />
              <h3 title={p.name}>{p.name}</h3>
              <strong>{brl(p.price)}</strong>
              <p>{p.discountRate > 0 ? `${p.discountRate}% OFF · ` : ""}⭐ {p.rating.toFixed(1)} · {number(p.sales)} vendidos</p>
              <p className="commission">Você recebe cerca de <strong>{brl(commissionOf(p.price, p.commissionRate))}</strong> ({p.commissionRate.toFixed(1)}%)</p>
              <Button variant="primary" disabled={selected.length === 0} busy={sending === p.itemId} onClick={() => void send(p)}>
                {selected.length === 0 ? "Escolha um grupo" : "Enviar"}
              </Button>
            </article>
          ))}
        </div>
      </Card>
    </>
  );
}

const couponText = (c: Coupon) => (c.kind === "percent" ? `${number(c.value)}% OFF` : `${brl(c.value)} OFF`);

export function CouponsPage(_props: PageProps) {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad<Coupon[]>("/coupons");
  const categories = useLoad<Category[]>("/categories");
  const blank = { code: "", kind: "percent" as Coupon["kind"], value: "", minPrice: "", maxDiscount: "", categoryId: "", expiresOn: "" };
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  const set = (key: keyof typeof blank, value: string) => setForm((f) => ({ ...f, [key]: value }));
  const today = isoDay(Date.now());

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await api("/coupons", "POST", {
        code: form.code,
        kind: form.kind,
        value: Number(form.value),
        minPrice: Number(form.minPrice || 0),
        maxDiscount: Number(form.maxDiscount || 0),
        categoryId: form.categoryId ? Number(form.categoryId) : null,
        expiresOn: form.expiresOn || null,
        active: true,
      });
      setForm(blank);
      toast.ok("Cupom cadastrado");
      await reload();
    } catch (reason) {
      toast.fail(reason);
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (coupon: Coupon, active: boolean) => {
    try {
      await api(`/coupons/${coupon.id}/active`, "PUT", { active });
      await reload();
    } catch (reason) {
      toast.fail(reason);
    }
  };

  return (
    <>
      <PageHead title="Cupons" sub="Cadastre os cupons que a Shopee liberar. O melhor cupom válido entra sozinho nas ofertas." />
      <Card title="Novo cupom">
        <form className="stack" onSubmit={create}>
          <div className="form-grid">
            <Field label="Código do cupom"><input value={form.code} onChange={(e) => set("code", e.target.value)} placeholder="Ex.: SHOPEE20" maxLength={30} required /></Field>
            <Field label="Tipo de desconto">
              <select value={form.kind} onChange={(e) => set("kind", e.target.value)}>
                <option value="percent">Porcentagem (%)</option>
                <option value="fixed">Valor fixo (R$)</option>
              </select>
            </Field>
            <Field label={form.kind === "percent" ? "Desconto (%)" : "Desconto (R$)"}><input type="number" step="0.01" min="0.01" value={form.value} onChange={(e) => set("value", e.target.value)} required /></Field>
            <Field label="Compra mínima (R$)" hint="Vazio = sem mínimo"><input type="number" step="0.01" min="0" value={form.minPrice} onChange={(e) => set("minPrice", e.target.value)} /></Field>
            <Field label="Desconto máximo (R$)" hint="Vazio = sem teto"><input type="number" step="0.01" min="0" value={form.maxDiscount} onChange={(e) => set("maxDiscount", e.target.value)} /></Field>
            <Field label="Validade" hint="Vale até o fim deste dia. Vazio = sem data"><input type="date" min={today} value={form.expiresOn} onChange={(e) => set("expiresOn", e.target.value)} /></Field>
            <Field label="Categoria" hint="Compara com a categoria do grupo">
              <select value={form.categoryId} onChange={(e) => set("categoryId", e.target.value)}>
                <option value="">Todas as categorias</option>
                {categories.data?.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
          </div>
          <div className="row"><Button type="submit" variant="primary" busy={saving}>Cadastrar cupom</Button></div>
        </form>
      </Card>
      <LoadState loading={loading && !data} error={error} onRetry={reload} />
      {data?.length === 0 && <Card><Empty title="Nenhum cupom cadastrado">Sem cupom, as ofertas saem normalmente.</Empty></Card>}
      <div className="groups">
        {data?.map((coupon) => {
          const expired = Boolean(coupon.expires_on && coupon.expires_on < today);
          const rules = [
            coupon.min_price > 0 ? `Mínimo ${brl(coupon.min_price)}` : "",
            coupon.max_discount > 0 ? `Teto ${brl(coupon.max_discount)}` : "",
            coupon.category_id ? categories.data?.find((c) => c.id === coupon.category_id)?.name ?? "" : "Todas as categorias",
            coupon.expires_on ? `Até ${coupon.expires_on.split("-").reverse().join("/")}` : "Sem validade",
          ].filter(Boolean);
          return (
            <Card key={coupon.id} title={coupon.code} action={expired ? <span className="tag tag-failed">Vencido</span> : <span className="tag tag-sent">{couponText(coupon)}</span>}>
              <p className="hint">{rules.join(" · ")}</p>
              <Toggle checked={Boolean(coupon.active)} onChange={(v) => void toggle(coupon, v)} label="Usar nas ofertas" />
            </Card>
          );
        })}
      </div>
    </>
  );
}

const slug = (text: string) => text.normalize("NFD").replace(/[^a-zA-Z0-9]/g, "").toLowerCase().slice(0, 14);

function groupPayload(g: Group, patch: Partial<Group>) {
  const next = { ...g, ...patch };
  return {
    jid: next.jid, name: next.name, code: next.code, categoryIds: next.category_ids,
    minCommissionValue: next.min_commission_value, minCommissionRate: next.min_commission_rate,
    active: Boolean(next.active), auto: Boolean(next.auto), approval: Boolean(next.approval),
    windowStart: next.window_start, windowEnd: next.window_end,
  };
}

export function GroupsPage({ status, go }: PageProps) {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad<Group[]>("/groups", 10000);
  const categories = useLoad<Category[]>("/categories");
  const [found, setFound] = useState<{ jid: string; name: string; size: number }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const connected = status?.whatsapp.state === "open";

  const find = async () => {
    setBusy(true);
    try {
      setFound(await api("/whatsapp/groups"));
    } catch (reason) {
      toast.fail(reason);
    } finally {
      setBusy(false);
    }
  };

  const add = async (group: { jid: string; name: string }) => {
    try {
      const suffix = Math.random().toString(36).slice(2, 6);
      await api("/groups", "POST", {
        jid: group.jid, name: group.name.slice(0, 100), code: `${slug(group.name) || "grupo"}${suffix}`, categoryIds: [],
        active: true, auto: false, approval: false, windowStart: null, windowEnd: null,
      });
      await reload();
    } catch (reason) {
      toast.fail(reason);
    }
  };

  const update = async (group: Group, patch: Partial<Group>) => {
    try {
      await api(`/groups/${group.id}`, "PUT", groupPayload(group, patch));
      await reload();
    } catch (reason) {
      toast.fail(reason);
    }
  };

  const known = new Set(data?.map((g) => g.jid));
  const activeCategories = categories.data?.filter((c) => c.active);

  return (
    <>
      <PageHead
        title="Grupos"
        sub="Cada grupo tem suas categorias, sua comissão mínima e sua automação."
        action={<Button variant="primary" onClick={find} busy={busy} disabled={!connected}>Buscar no WhatsApp</Button>}
      />
      {!connected && (
        <div className="notice notice-warn">
          <span>Conecte o WhatsApp para buscar seus grupos.</span>
          <Button variant="ghost" onClick={() => go("settings")}>Conectar</Button>
        </div>
      )}
      {found && (
        <Card title="Grupos encontrados">
          {found.filter((g) => !known.has(g.jid)).length === 0 && <Empty title="Todos os grupos já estão cadastrados" />}
          <ul className="list">
            {found.filter((g) => !known.has(g.jid)).map((g) => (
              <li key={g.jid}><span>{g.name} <small>{number(g.size)} pessoas</small></span><Button onClick={() => void add(g)}>Adicionar</Button></li>
            ))}
          </ul>
        </Card>
      )}
      <LoadState loading={loading && !data} error={error} onRetry={reload} />
      {data?.length === 0 && <Card><Empty title="Nenhum grupo cadastrado" /></Card>}
      <div className="groups">
        {data?.map((group) => (
          <Card key={group.id} title={group.name} action={<code title="Código usado no sub ID">{group.code}</code>}>
            <div className={group.automation.running ? "run-state on" : "run-state"} role="status">
              <i aria-hidden="true" />
              <span>
                <strong>{group.automation.running ? "Automação ativa" : "Automação inativa"}</strong>
                <small>{group.automation.reason}</small>
              </span>
            </div>
            <Toggle
              checked={Boolean(group.auto)}
              onChange={(v) => void update(group, { auto: v ? 1 : 0 })}
              label="Ligar automação neste grupo"
              hint="Desligado, o grupo só recebe o que você enviar manualmente."
            />
            <div className="field">
              <span className="field-label">Categorias do grupo</span>
              {activeCategories?.length === 0 && <span className="hint">Ative categorias na aba Categorias.</span>}
              <div className="chips">
                {categories.data?.filter((c) => c.active || group.category_ids.includes(c.id)).map((c) => {
                  const on = group.category_ids.includes(c.id);
                  return (
                    <label key={c.id} className={on ? "chip on" : "chip"}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => void update(group, { category_ids: on ? group.category_ids.filter((id) => id !== c.id) : [...group.category_ids, c.id] })}
                      />
                      {c.name}
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="form-grid">
              <Field label="Comissão mínima (R$)" hint="Por venda. 0 = sem mínimo">
                <input type="number" step="0.01" min="0" defaultValue={group.min_commission_value} onBlur={(e) => { const value = Number(e.target.value || 0); if (value !== group.min_commission_value) void update(group, { min_commission_value: value }); }} />
              </Field>
              <Field label="Comissão mínima (%)" hint="0 = sem mínimo">
                <input type="number" step="0.1" min="0" max="100" defaultValue={group.min_commission_rate} onBlur={(e) => { const value = Number(e.target.value || 0); if (value !== group.min_commission_rate) void update(group, { min_commission_rate: value }); }} />
              </Field>
              <Field label="Começa às" hint="Vazio = janela geral">
                <input type="time" defaultValue={group.window_start ?? ""} onBlur={(e) => { if ((e.target.value || null) !== group.window_start) void update(group, { window_start: e.target.value || null }); }} />
              </Field>
              <Field label="Termina às" hint="Vazio = janela geral">
                <input type="time" defaultValue={group.window_end ?? ""} onBlur={(e) => { if ((e.target.value || null) !== group.window_end) void update(group, { window_end: e.target.value || null }); }} />
              </Field>
            </div>
            <Toggle checked={Boolean(group.active)} onChange={(v) => void update(group, { active: v ? 1 : 0 })} label="Grupo ativo" hint="Desativado, nada é enviado para este grupo, nem manualmente." />
            <Toggle checked={Boolean(group.approval)} onChange={(v) => void update(group, { approval: v ? 1 : 0 })} label="Aprovar antes de enviar" />
          </Card>
        ))}
      </div>
    </>
  );
}

export function CategoriesPage(_props: PageProps) {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad<Category[]>("/categories");

  const save = async (category: Category, patch: Partial<Category>) => {
    const next = { ...category, ...patch };
    try {
      await api(`/categories/${category.id}`, "PUT", { name: next.name, code: next.code, keywords: next.keywords, active: Boolean(next.active) });
      await reload();
    } catch (reason) {
      toast.fail(reason);
    }
  };

  const [name, setName] = useState("");
  const [words, setWords] = useState("");

  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const keywords = words.split(",").map((k) => k.trim()).filter(Boolean);
      await api("/categories", "POST", { name, code: slug(name).slice(0, 20), keywords, active: true });
      setName("");
      setWords("");
      await reload();
    } catch (reason) {
      toast.fail(reason);
    }
  };

  return (
    <>
      <PageHead title="Categorias" sub="Ative as que vai usar e ajuste as palavras buscadas na Shopee." />
      <LoadState loading={loading && !data} error={error} onRetry={reload} />
      <Card title="Nova categoria">
        <form className="search" onSubmit={create}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome" aria-label="Nome da categoria" minLength={2} required />
          <input value={words} onChange={(e) => setWords(e.target.value)} placeholder="Palavras de busca, separadas por vírgula" aria-label="Palavras de busca" required />
          <Button type="submit" variant="primary">Adicionar</Button>
        </form>
      </Card>
      <div className="categories">
        {data?.map((category) => (
          <div key={category.id} className={category.active ? "category on" : "category"}>
            <Toggle checked={Boolean(category.active)} onChange={(v) => void save(category, { active: v ? 1 : 0 })} label={category.name} />
            <input
              aria-label={`Palavras de busca de ${category.name}`}
              defaultValue={category.keywords.join(", ")}
              onBlur={(e) => {
                const keywords = e.target.value.split(",").map((k) => k.trim()).filter(Boolean);
                if (keywords.join() !== category.keywords.join()) void save(category, { keywords });
              }}
            />
          </div>
        ))}
      </div>
    </>
  );
}

function Integrations({ reloadStatus }: { reloadStatus: () => Promise<void> }) {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad<IntegrationSection[]>("/integrations");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string }>>({});

  const write = async (values: Record<string, string | null>, tag: string) => {
    setBusy(tag);
    try {
      await api("/integrations", "PUT", { values });
      setDrafts((all) => Object.fromEntries(Object.entries(all).filter(([key]) => !(key in values))));
      await Promise.all([reload(), reloadStatus()]);
      toast.ok("Salvo. Já está valendo.");
    } catch (reason) {
      toast.fail(reason);
    } finally {
      setBusy("");
    }
  };

  const save = (section: IntegrationSection) => {
    const values: Record<string, string> = {};
    for (const field of section.fields) {
      const draft = drafts[field.key]?.trim();
      if (draft) values[field.key] = draft;
    }
    if (Object.keys(values).length === 0) return toast.fail(new Error("Nada novo para salvar"));
    void write(values, `save:${section.id}`);
  };

  const test = async (section: IntegrationSection) => {
    setBusy(`test:${section.id}`);
    try {
      // O teste precisa usar o que está digitado, não a chave salva anteriormente.
      const typed = Object.fromEntries(section.fields.flatMap((field) => {
        const draft = drafts[field.key]?.trim();
        return draft ? [[field.key, draft]] : [];
      }));
      if (Object.keys(typed).length > 0) {
        await api("/integrations", "PUT", { values: typed });
        setDrafts((all) => Object.fromEntries(Object.entries(all).filter(([key]) => !(key in typed))));
        await Promise.all([reload(), reloadStatus()]);
      }
      const result = await api<{ ok: boolean; message: string }>(`/integrations/${section.id}/test`, "POST");
      setResults((all) => ({ ...all, [section.id]: result }));
    } catch (reason) {
      toast.fail(reason);
    } finally {
      setBusy("");
    }
  };

  return (
    <>
      <LoadState loading={loading && !data} error={error} onRetry={reload} />
      {data?.map((section) => (
        <Card key={section.id} title={section.name}>
          <p className="hint">{section.help}</p>
          <div className="form-grid">
            {section.fields.map((field) => (
              <Field key={field.key} label={field.label} hint={field.hint}>
                {field.options ? (
                  <select value={drafts[field.key] ?? (field.value || "auto")} onChange={(e) => void write({ [field.key]: e.target.value }, `save:${section.id}`)}>
                    {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                ) : (
                  <input
                    type={field.secret ? "password" : "text"}
                    autoComplete="new-password"
                    spellCheck={false}
                    value={drafts[field.key] ?? (field.secret ? "" : field.value ?? "")}
                    placeholder={field.secret && field.configured ? `Salvo${field.ending ? ` (final ${field.ending})` : ""}. Digite para trocar` : ""}
                    onChange={(e) => setDrafts((all) => ({ ...all, [field.key]: e.target.value }))}
                  />
                )}
                {field.source === "arquivo" && <span className="hint">Vindo do arquivo .env. Salve aqui para o painel assumir.</span>}
                {field.source === "painel" && field.secret && (
                  <button type="button" className="link-danger" onClick={() => void write({ [field.key]: null }, `save:${section.id}`)}>Apagar do painel</button>
                )}
              </Field>
            ))}
          </div>
          {!section.fields.some((field) => field.options) && (
            <div className="row">
              <Button variant="primary" busy={busy === `save:${section.id}`} onClick={() => save(section)}>Salvar</Button>
              {section.testable && <Button busy={busy === `test:${section.id}`} onClick={() => void test(section)}>Testar conexão</Button>}
            </div>
          )}
          {results[section.id] && <div className={`notice ${results[section.id]!.ok ? "notice-ok" : "notice-error"}`} role="status">{results[section.id]!.message}</div>}
        </Card>
      ))}
    </>
  );
}

const PRESET_TEXT = { conservador: "Para começar", moderado: "Número aquecido", acelerado: "Mais risco" };

const RATE_FIELDS: [keyof Rate, string][] = [
  ["maxPerMinute", "Mensagens por minuto"],
  ["groupIntervalMin", "Intervalo mín. no grupo (min)"],
  ["groupIntervalMax", "Intervalo máx. no grupo (min)"],
  ["maxPerDay", "Ofertas por grupo ao dia"],
  ["jitterMin", "Espera extra mín. (s)"],
  ["jitterMax", "Espera extra máx. (s)"],
  ["repeatDays", "Não repetir produto (dias)"],
];

export function SettingsPage({ status, reloadStatus }: PageProps) {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad<{ settings: Settings; presets: Record<string, Rate> }>("/settings");
  const logs = useLoad<{ id: number; ts: number; level: string; message: string }[]>("/logs", 15000);
  const [form, setForm] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    if (data) setForm(data.settings);
  }, [data]);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setForm((f) => (f ? { ...f, [key]: value } : f));

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await api("/settings", "PUT", form);
      toast.ok("Ajustes salvos");
      await Promise.all([reload(), reloadStatus()]);
    } catch (reason) {
      toast.fail(reason);
    } finally {
      setSaving(false);
    }
  };

  const connect = async () => {
    setConnecting(true);
    try {
      await api("/whatsapp/connect", "POST");
      await reloadStatus();
    } catch (reason) {
      toast.fail(reason);
    } finally {
      setConnecting(false);
    }
  };

  const wa = status?.whatsapp;
  const presetKeys = ["conservador", "moderado", "acelerado"] as const;

  return (
    <>
      <PageHead title="Ajustes" sub="Conexões, ritmo de envio e formato da mensagem." />
      <LoadState loading={loading && !data} error={error} onRetry={reload} />
      <Card title="WhatsApp">
        {wa?.state === "open" && <p className="ok-line"><Check size={17} aria-hidden="true" /> Número conectado e monitorado.</p>}
        {wa?.state === "qr" && wa.qr && (
          <div className="enroll">
            <img src={wa.qr} alt="QR Code do WhatsApp" width={240} height={240} />
            <p className="hint">No celular do chip dedicado: WhatsApp &gt; Aparelhos conectados &gt; Conectar um aparelho.</p>
          </div>
        )}
        {wa?.detail && <p className="hint">{wa.detail}</p>}
        {wa?.state !== "open" && wa?.state !== "qr" && (
          <Button variant="primary" onClick={connect} busy={connecting || wa?.state === "connecting"}>Conectar WhatsApp</Button>
        )}
      </Card>
      <Integrations reloadStatus={reloadStatus} />
      <Card title="Mercado Livre e outras plataformas">
        <p className="hint">Ainda não conectados. Cada plataforma precisa de um conector próprio; quando ele existir, as chaves entram aqui, neste mesmo painel.</p>
      </Card>
      <Card title="Registros recentes">
        {logs.data?.length === 0 && <Empty title="Nenhum registro ainda" />}
        <ul className="list logs">
          {logs.data?.slice(0, 12).map((entry) => (
            <li key={entry.id}><span className={`tag tag-${entry.level}`}>{entry.level === "error" ? "Erro" : entry.level === "warn" ? "Alerta" : "Info"}</span><span>{entry.message}</span><small>{dateTime(entry.ts)}</small></li>
          ))}
        </ul>
      </Card>
      {form && (
        <form onSubmit={save} className="stack">
          <Card title="Automação">
            <Toggle checked={form.autoMode} onChange={(v) => set("autoMode", v)} label="Modo automático" hint="Garimpa e abastece a fila dos grupos com categoria ativa." />
            <Toggle checked={form.useAi} onChange={(v) => set("useAi", v)} label="Escrever a chamada com IA" />
          </Card>
          <Card title="Ritmo">
            <div className="presets">
              {presetKeys.map((key) => {
                const rate = data?.presets[key];
                return (
                  <button key={key} type="button" className={form.preset === key ? "preset on" : "preset"} aria-pressed={form.preset === key} onClick={() => set("preset", key)}>
                    <strong>{key[0]!.toUpperCase() + key.slice(1)}</strong>
                    <small>{PRESET_TEXT[key]}</small>
                    {rate && <span>A cada {rate.groupIntervalMin}–{rate.groupIntervalMax} min · até {rate.maxPerDay}/dia</span>}
                  </button>
                );
              })}
              <button type="button" className={form.preset === "personalizado" ? "preset on" : "preset"} aria-pressed={form.preset === "personalizado"} onClick={() => set("preset", "personalizado")}>
                <strong>Personalizado</strong>
                <small>Você define</small>
              </button>
            </div>
            {form.preset === "personalizado" && (
              <div className="form-grid">
                {RATE_FIELDS.map(([key, label]) => (
                  <Field key={key} label={label}>
                    <input type="number" step="any" min={0} value={form.custom[key]} onChange={(e) => set("custom", { ...form.custom, [key]: Number(e.target.value) })} />
                  </Field>
                ))}
              </div>
            )}
          </Card>
          <Card title="Janela de envio e filtros">
            <div className="form-grid">
              <Field label="Começa às"><input type="time" value={form.windowStart} onChange={(e) => set("windowStart", e.target.value)} required /></Field>
              <Field label="Termina às"><input type="time" value={form.windowEnd} onChange={(e) => set("windowEnd", e.target.value)} required /></Field>
              <Field label="Nota mínima"><input type="number" step="0.1" min={0} max={5} value={form.minRating} onChange={(e) => set("minRating", Number(e.target.value))} /></Field>
              <Field label="Desconto mínimo (%)"><input type="number" min={0} max={95} value={form.minDiscount} onChange={(e) => set("minDiscount", Number(e.target.value))} /></Field>
              <Field label="Preço mínimo (R$)"><input type="number" step="0.01" min={0} value={form.minPrice} onChange={(e) => set("minPrice", Number(e.target.value))} /></Field>
              <Field label="Preço máximo (R$)" hint="0 = sem limite"><input type="number" step="0.01" min={0} value={form.maxPrice} onChange={(e) => set("maxPrice", Number(e.target.value))} /></Field>
            </div>
          </Card>
          <Card title="Aprovação pelo WhatsApp">
            <Field label="Seu número pessoal" hint="Só números, com DDD. O 55 do Brasil é colocado sozinho. Ex.: 71999998888">
              <input value={form.approverNumber} onChange={(e) => set("approverNumber", e.target.value.replace(/\D/g, ""))} inputMode="numeric" maxLength={15} />
            </Field>
          </Card>
          <Card title="Layout da mensagem">
            <Field label="Modelo" hint="Variáveis: {chamada} {titulo} {preco_antigo} {preco} {cupom} {desconto} {nota} {loja_oficial} {loja} {link}. Use *texto* para negrito e ~texto~ para riscado.">
              <textarea rows={8} value={form.layout} onChange={(e) => set("layout", e.target.value)} required />
            </Field>
          </Card>
          <div className="save-bar"><Button type="submit" variant="primary" busy={saving}>Salvar ajustes</Button></div>
        </form>
      )}
    </>
  );
}
