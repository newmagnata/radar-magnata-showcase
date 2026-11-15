import type { Db } from "./db.ts";

export interface CouponRow {
  id: number;
  code: string;
  kind: "percent" | "fixed";
  value: number;
  min_price: number;
  max_discount: number;
  category_id: number | null;
  expires_on: string | null;
  active: number;
}

export interface AppliedCoupon {
  id: number;
  code: string;
  finalPrice: number;
}

export function todaySaoPaulo(ms: number): string {
  return new Date(ms - 3 * 3_600_000).toISOString().slice(0, 10);
}

export function isOpen(coupon: CouponRow, ms: number): boolean {
  return coupon.active === 1 && (!coupon.expires_on || coupon.expires_on >= todaySaoPaulo(ms));
}

function discountFor(coupon: CouponRow, price: number): number {
  const raw = coupon.kind === "percent" ? (price * coupon.value) / 100 : coupon.value;
  const capped = coupon.max_discount > 0 ? Math.min(raw, coupon.max_discount) : raw;
  return Math.min(capped, price);
}

/** Devolve o motivo quando o cupom não vale para este produto e grupo. */
export function whyNot(coupon: CouponRow, price: number, categoryId: number | null, ms: number): string | null {
  if (coupon.active !== 1) return "está desativado";
  if (!isOpen(coupon, ms)) return "está vencido";
  if (price < coupon.min_price) return `exige compra mínima de R$ ${coupon.min_price}`;
  if (coupon.category_id !== null && coupon.category_id !== categoryId) return "não vale para a categoria deste grupo";
  return discountFor(coupon, price) >= price ? "zeraria o preço do produto" : null;
}

export function applyCoupon(coupon: CouponRow, price: number): AppliedCoupon {
  const finalPrice = Math.round((price - discountFor(coupon, price)) * 100) / 100;
  return { id: coupon.id, code: coupon.code, finalPrice };
}

export function bestCoupon(db: Db, price: number, categoryId: number | null, ms: number): AppliedCoupon | null {
  const coupons = db.prepare("SELECT * FROM coupons WHERE active = 1").all() as unknown as CouponRow[];
  return (
    coupons
      .filter((coupon) => whyNot(coupon, price, categoryId, ms) === null)
      .map((coupon) => applyCoupon(coupon, price))
      .sort((a, b) => a.finalPrice - b.finalPrice)[0] ?? null
  );
}
