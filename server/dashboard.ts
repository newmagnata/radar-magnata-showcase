import type { Db } from "./db.ts";

export interface DashboardFilter {
  from: string;
  to: string;
  groupId?: number;
  categoryId?: number;
}

const DAY = "date(%COL% - 10800, 'unixepoch')";

function secondsAtStart(day: string): number {
  return Date.parse(`${day}T00:00:00-03:00`) / 1000;
}

export function dashboard(db: Db, filter: DashboardFilter) {
  const start = secondsAtStart(filter.from);
  const end = secondsAtStart(filter.to) + 86_400;
  const scope: (string | number)[] = [start, end];
  let where = "purchase_time >= ? AND purchase_time < ? AND status <> 'canceled'";
  if (filter.groupId) {
    where += " AND group_id = ?";
    scope.push(filter.groupId);
  }
  if (filter.categoryId) {
    where += " AND category_id = ?";
    scope.push(filter.categoryId);
  }

  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(commission), 0) AS commission,
              COALESCE(SUM(CASE WHEN status = 'validated' THEN commission END), 0) AS validated,
              COALESCE(SUM(CASE WHEN status = 'pending' THEN commission END), 0) AS pending,
              COALESCE(SUM(gmv), 0) AS gmv,
              COUNT(DISTINCT order_id) AS orders
       FROM conversions WHERE ${where}`,
    )
    .get(...scope);

  const day = DAY.replace("%COL%", "purchase_time");
  const daily = db
    .prepare(
      `SELECT ${day} AS day, SUM(commission) AS commission, SUM(gmv) AS gmv, COUNT(DISTINCT order_id) AS orders
       FROM conversions WHERE ${where} GROUP BY day ORDER BY day`,
    )
    .all(...scope);

  const monthly = db
    .prepare(
      `SELECT substr(${day}, 1, 7) AS month, SUM(commission) AS commission, SUM(gmv) AS gmv, COUNT(DISTINCT order_id) AS orders
       FROM conversions WHERE ${where} GROUP BY month ORDER BY month`,
    )
    .all(...scope);

  const ranking = (label: string, join: string, key: string) =>
    db
      .prepare(
        `SELECT COALESCE(${label}, 'Sem identificação') AS name, SUM(commission) AS commission, SUM(gmv) AS gmv, COUNT(DISTINCT order_id) AS orders
         FROM conversions c ${join} WHERE ${where.replaceAll("group_id", "c.group_id").replaceAll("category_id", "c.category_id")}
         GROUP BY ${key} ORDER BY commission DESC LIMIT 10`,
      )
      .all(...scope);

  const leadScope: (string | number)[] = [start, end];
  let leadWhere = "e.ts >= ? AND e.ts < ?";
  if (filter.groupId) {
    leadWhere += " AND e.group_id = ?";
    leadScope.push(filter.groupId);
  }
  if (filter.categoryId) {
    leadWhere += " AND e.group_id IN (SELECT group_id FROM group_categories WHERE category_id = ?)";
    leadScope.push(filter.categoryId);
  }
  const leadDay = DAY.replace("%COL%", "e.ts");
  const leads = db
    .prepare(
      `SELECT ${leadDay} AS day,
              SUM(CASE WHEN e.action = 'add' THEN 1 ELSE 0 END) AS joined,
              SUM(CASE WHEN e.action = 'remove' THEN 1 ELSE 0 END) AS left_group
       FROM group_events e JOIN groups g ON g.id = e.group_id WHERE ${leadWhere} GROUP BY day ORDER BY day`,
    )
    .all(...leadScope) as unknown as { day: string; joined: number; left_group: number }[];

  return {
    totals,
    daily,
    monthly,
    byGroup: ranking("g.name", "LEFT JOIN groups g ON g.id = c.group_id", "c.group_id"),
    byCategory: ranking("cat.name", "LEFT JOIN categories cat ON cat.id = c.category_id", "c.category_id"),
    byProduct: ranking("c.item_name", "", "c.item_id"),
    origin: ranking("CASE c.origin WHEN 'auto' THEN 'Automático' WHEN 'manual' THEN 'Manual' END", "", "c.origin"),
    leads: {
      daily: leads,
      joined: leads.reduce((sum, row) => sum + row.joined, 0),
      left: leads.reduce((sum, row) => sum + row.left_group, 0),
    },
  };
}
