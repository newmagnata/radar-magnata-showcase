import { createHash } from "node:crypto";

export class ShopeeError extends Error {}

export interface ShopeeProduct {
  itemId: string;
  name: string;
  imageUrl: string;
  productLink: string;
  price: number;
  discountRate: number;
  commissionRate: number;
  rating: number;
  sales: number;
  shopName: string;
  officialStore: boolean;
}

export interface ConversionItem {
  key: string;
  orderId: string;
  itemId: string;
  itemName: string;
  status: "pending" | "validated" | "canceled";
  gmv: number;
  commission: number;
  purchaseTime: number;
  utmContent: string;
}

export interface SearchInput {
  keyword: string;
  sortType: 2 | 5;
  limit: number;
  page?: number;
}

export interface ShopeeApi {
  configured(): boolean;
  search(input: SearchInput): Promise<ShopeeProduct[]>;
  shortLink(originUrl: string, subIds: string[]): Promise<string>;
  conversions(startSeconds: number, endSeconds: number): Promise<ConversionItem[]>;
}

const IMAGE_HOSTS = ["susercontent.com", "shopee.com.br", "shopee.com"];

export function allowedImage(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" && IMAGE_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function imageUrl(raw: unknown): string {
  const value = String(raw ?? "");
  return /^https?:/.test(value) ? value : `https://down-br.img.susercontent.com/file/${value}`;
}

function mapStatus(orderStatus: string): ConversionItem["status"] {
  const status = orderStatus.toUpperCase();
  if (status === "CANCELLED" || status === "CANCELED") return "canceled";
  return status === "COMPLETED" ? "validated" : "pending";
}

interface Options {
  appId?: string;
  secret?: string;
  endpoint: string;
  retryMs?: number;
}

export class ShopeeClient implements ShopeeApi {
  private readonly options: Options;

  constructor(options: Options) {
    this.options = options;
  }

  configured(): boolean {
    return Boolean(this.options.appId && this.options.secret);
  }

  /** A Shopee devolve "System Error" (10000) de forma intermitente; repetir costuma resolver. */
  private async graphql<T>(query: string): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.request<T>(query);
      } catch (error) {
        if (attempt >= 5 || !(error instanceof ShopeeError) || !error.message.includes("10000")) throw error;
        await new Promise((resolve) => setTimeout(resolve, this.options.retryMs ?? 2000));
      }
    }
  }

  private async request<T>(query: string): Promise<T> {
    const { appId, secret, endpoint } = this.options;
    if (!appId || !secret) throw new ShopeeError("Chaves da Shopee não configuradas no arquivo .env");
    const body = JSON.stringify({ query });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHash("sha256").update(`${appId}${timestamp}${body}${secret}`).digest("hex");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new ShopeeError(`Shopee respondeu HTTP ${response.status}`);
    const json = (await response.json()) as { data?: T; errors?: { message?: string }[] };
    if (json.errors?.length) throw new ShopeeError(`Shopee: ${json.errors[0]?.message ?? "erro desconhecido"}`);
    if (!json.data) throw new ShopeeError("Shopee: resposta sem dados");
    return json.data;
  }

  async search({ keyword, sortType, limit, page = 1 }: SearchInput): Promise<ShopeeProduct[]> {
    const data = await this.graphql<{ productOfferV2: { nodes: Record<string, unknown>[] } }>(
      `query { productOfferV2(keyword: ${JSON.stringify(keyword)}, sortType: ${sortType}, page: ${page}, limit: ${limit}) {
        nodes { itemId productName commissionRate priceMin priceDiscountRate ratingStar sales imageUrl productLink offerLink shopName shopType }
      } }`,
    );
    return data.productOfferV2.nodes.map((n) => ({
      itemId: String(n.itemId),
      name: String(n.productName ?? ""),
      imageUrl: imageUrl(n.imageUrl),
      productLink: String(n.productLink ?? n.offerLink ?? ""),
      price: Number(n.priceMin ?? 0),
      discountRate: Number(n.priceDiscountRate ?? 0),
      commissionRate: Number(n.commissionRate ?? 0) * 100,
      rating: Number(n.ratingStar ?? 0),
      sales: Number(n.sales ?? 0),
      shopName: String(n.shopName ?? ""),
      // Na Shopee, o tipo 1 é a Shopee Mall, o selo de loja oficial.
      officialStore: Array.isArray(n.shopType) && n.shopType.includes(1),
    }));
  }

  async shortLink(originUrl: string, subIds: string[]): Promise<string> {
    const data = await this.graphql<{ generateShortLink: { shortLink: string } }>(
      `mutation { generateShortLink(input: { originUrl: ${JSON.stringify(originUrl)}, subIds: ${JSON.stringify(subIds)} }) { shortLink } }`,
    );
    return data.generateShortLink.shortLink;
  }

  async conversions(startSeconds: number, endSeconds: number): Promise<ConversionItem[]> {
    const output: ConversionItem[] = [];
    let scrollId = "";
    for (let page = 0; page < 200; page++) {
      const scroll = scrollId ? `, scrollId: ${JSON.stringify(scrollId)}` : "";
      const data = await this.graphql<{
        conversionReport: {
          nodes: RawConversion[];
          pageInfo: { hasNextPage: boolean; scrollId?: string };
        };
      }>(
        `query { conversionReport(purchaseTimeStart: ${startSeconds}, purchaseTimeEnd: ${endSeconds}, limit: 500${scroll}) {
          nodes { conversionId purchaseTime utmContent orders { orderId orderStatus items { itemId itemName actualAmount itemTotalCommission } } }
          pageInfo { hasNextPage scrollId }
        } }`,
      );
      for (const node of data.conversionReport.nodes) {
        for (const order of node.orders ?? []) {
          for (const [position, item] of (order.items ?? []).entries()) {
            output.push({
              key: `${node.conversionId}:${order.orderId}:${item.itemId}:${position}`,
              orderId: String(order.orderId),
              itemId: String(item.itemId),
              itemName: String(item.itemName ?? ""),
              status: mapStatus(String(order.orderStatus ?? "")),
              gmv: Number(item.actualAmount ?? 0),
              commission: Number(item.itemTotalCommission ?? 0),
              purchaseTime: Number(node.purchaseTime),
              utmContent: String(node.utmContent ?? ""),
            });
          }
        }
      }
      const info = data.conversionReport.pageInfo;
      if (!info.hasNextPage || !info.scrollId) return output;
      scrollId = info.scrollId;
    }
    return output;
  }
}

interface RawConversion {
  conversionId: string | number;
  purchaseTime: number;
  utmContent?: string;
  orders?: {
    orderId: string | number;
    orderStatus?: string;
    items?: { itemId: string | number; itemName?: string; actualAmount?: string | number; itemTotalCommission?: string | number }[];
  }[];
}
