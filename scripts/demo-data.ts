// Loads realistic sample data so every page can be tried out:
//   npm run demo:load
// Remove it all again (keeps the administrator, roles, settings and categories) with:
//   npm run demo:clear -- --yes
//
// Demo staff (aina = supervisor, mei and jason = CS, siti = data entry) sign in with DEMO_PASSWORD from .env,
// or a random password printed at the end.

import "dotenv/config";
import { randomBytes, scryptSync } from "node:crypto";
import { PrismaClient, type TxnType } from "@prisma/client";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || randomBytes(9).toString("base64url");
const prisma = new PrismaClient();

let seed = 20261028;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const between = (a: number, b: number) => a + rnd() * (b - a);

const OFFSET = 8 * 3600_000;
const today = new Date(Date.now() + OFFSET).toISOString().slice(0, 10);
const dayStr = (n: number) => {
  const d = new Date(today + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
/** A Malaysia wall-clock time on day `n` days ago. */
const at = (n: number, hour = between(9, 24)) => new Date(new Date(dayStr(n) + "T00:00:00Z").getTime() - OFFSET + hour * 3600_000);
const DAYS = 75;

function hash(pw: string) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64")}$${scryptSync(pw, salt, 64).toString("base64")}`;
}

async function main() {
  if ((await prisma.brand.count()) > 0) {
    console.log("There are already brands in the database. Run `npm run demo:clear -- --yes` first if you want fresh demo data.");
    return;
  }
  const roles = Object.fromEntries((await prisma.role.findMany()).map((r) => [r.name, r.id]));
  if (!roles["Administrator"]) throw new Error("Run `npm run db:seed` first.");

  const brands = await Promise.all([
    prisma.brand.create({ data: { name: "Brand A", currency: "MYR", fxRate: 1 } }),
    prisma.brand.create({ data: { name: "Brand B", currency: "MYR", fxRate: 1 } }),
    prisma.brand.create({ data: { name: "Brand C", currency: "SGD", fxRate: 3.45 } }),
  ]);
  const scale = [1, 0.6, 0.12]; // Brand C is in SGD, so smaller numbers

  const openingAt = new Date(new Date(dayStr(DAYS + 1) + "T00:00:00Z").getTime() - OFFSET);
  const channels = await Promise.all([
    prisma.payChannel.create({ data: { name: "FPay", type: "PG", currency: "MYR", feePercent: 2, feeFixed: 0, openingAt } }),
    prisma.payChannel.create({ data: { name: "SurePay", type: "PG", currency: "MYR", feePercent: 1.8, feeFixed: 0.5, openingAt } }),
    prisma.payChannel.create({ data: { name: "Maybank 1234", type: "BANK", currency: "MYR", openingBalance: 150000, openingAt } }),
    prisma.payChannel.create({ data: { name: "DBS 7788", type: "BANK", currency: "SGD", openingBalance: 20000, openingAt } }),
  ]);
  const [fpay, surepay, maybank, dbs] = channels;

  // Staff
  const pw = hash(DEMO_PASSWORD);
  const staff = {
    aina: await prisma.user.create({ data: { username: "aina", name: "Aina", passwordHash: pw, roleId: roles["Supervisor"], allBrands: true } }),
    mei: await prisma.user.create({ data: { username: "mei", name: "Mei", passwordHash: pw, roleId: roles["Customer service"], brands: { create: [{ brandId: brands[0].id }, { brandId: brands[1].id }] } } }),
    jason: await prisma.user.create({ data: { username: "jason", name: "Jason", passwordHash: pw, roleId: roles["Customer service"], brands: { create: brands.map((b) => ({ brandId: b.id })) } } }),
    siti: await prisma.user.create({ data: { username: "siti", name: "Siti", passwordHash: pw, roleId: roles["Data entry"], brands: { create: [{ brandId: brands[0].id }] } } }),
  };

  // Players: some people play in more than one brand (same phone).
  const sharedPhones = Array.from({ length: 40 }, () => `601${Math.floor(between(10000000, 99999999))}`);
  const names = ["ahmad", "kelvin", "raj", "wen", "siti", "lim", "tan", "nur", "ali", "chong", "mohd", "jia", "farah", "ken", "dev", "hui", "amir", "yen", "zul", "bella"];
  const promoNames = ["Daily first deposit 20%", "Weekend reload 10%", "New member 100%", "Comeback bonus"];

  for (const [bi, brand] of brands.entries()) {
    const k = scale[bi];
    const n = [320, 240, 120][bi];
    await prisma.player.createMany({
      data: Array.from({ length: n }, (_, i) => {
        const phone = i < 25 ? sharedPhones[(i + bi * 7) % sharedPhones.length] : `601${Math.floor(between(10000000, 99999999))}`;
        return {
          brandId: brand.id,
          username: `${pick(names)}${String(i).padStart(3, "0")}${"abc"[bi]}`,
          phone,
          phoneKey: phone.slice(-9),
          name: rnd() < 0.4 ? pick(["Ahmad Faiz", "Kelvin Lee", "Raj Kumar", "Siti Aminah", "Lim Wei", "Tan Mei Ling", "Nur Aisyah"]) : null,
        };
      }),
      skipDuplicates: true,
    });
    const players = await prisma.player.findMany({ where: { brandId: brand.id } });

    // Each player gets a profile: how often and how much, and when they stopped (churn).
    const txns: { brandId: number; playerId: number; type: TxnType; amount: number; txnAt: Date; channelId: number }[] = [];
    for (const p of players) {
      const r = rnd();
      const profile = r < 0.06 ? { freq: 0.6, amt: [800, 4000] } : r < 0.35 ? { freq: 0.25, amt: [150, 800] } : { freq: 0.07, amt: [30, 250] };
      const start = Math.floor(between(0, DAYS));
      const stopped = rnd() < 0.3 ? Math.floor(between(5, 45)) : 0; // days ago they stopped
      for (let d = start; d >= stopped; d--) {
        if (rnd() > profile.freq) continue;
        const dep = Math.round(between(profile.amt[0], profile.amt[1]) * k);
        const inAcc = bi === 2 ? dbs : pick([fpay, surepay, maybank]);
        const outAcc = bi === 2 ? dbs : maybank;
        txns.push({ brandId: brand.id, playerId: p.id, type: "DEPOSIT", amount: dep, txnAt: at(d), channelId: inAcc.id });
        if (rnd() < 0.42) txns.push({ brandId: brand.id, playerId: p.id, type: "WITHDRAW", amount: Math.round(dep * between(0.6, 2.1)), txnAt: at(d, between(10, 24)), channelId: outAcc.id });
      }
    }
    for (let i = 0; i < txns.length; i += 2000) await prisma.txn.createMany({ data: txns.slice(i, i + 2000) });

    // Promotions and claims, and the deposits that followed.
    const promos = await Promise.all(promoNames.map((name) => prisma.promotion.create({ data: { brandId: brand.id, name } })));
    const claims: { promotionId: number; playerId: number; amount: number; claimedAt: Date }[] = [];
    for (const [pi, promo] of promos.entries()) {
      for (let i = 0; i < [90, 50, 25, 30][pi] * (bi === 2 ? 0.4 : 1); i++) {
        const p = pick(players);
        const d = Math.floor(between(0, DAYS - 5));
        const amt = Math.round([between(10, 80), between(10, 50), between(50, 300), between(20, 50)][pi] * k);
        claims.push({ promotionId: promo.id, playerId: p.id, amount: amt, claimedAt: at(d) });
      }
    }
    await prisma.promoClaim.createMany({ data: claims });

    // Company expenses and income.
    const cats = Object.fromEntries((await prisma.expenseCategory.findMany()).map((c) => [c.name, c.id]));
    const exp: { brandId: number; categoryId: number; date: Date; amount: number; note?: string }[] = [];
    for (let d = DAYS; d >= 0; d--) {
      const day = dayStr(d);
      if (day.endsWith("-01")) {
        exp.push({ brandId: brand.id, categoryId: cats["Salary"], date: new Date(day + "T00:00:00Z"), amount: Math.round(38000 * k), note: "Monthly payroll" });
        exp.push({ brandId: brand.id, categoryId: cats["Rental"], date: new Date(day + "T00:00:00Z"), amount: Math.round(6500 * k) });
        exp.push({ brandId: brand.id, categoryId: cats["Provider rebate"], date: new Date(day + "T00:00:00Z"), amount: Math.round(9000 * k) });
      }
      if (new Date(day + "T00:00:00Z").getUTCDay() === 1) exp.push({ brandId: brand.id, categoryId: cats["Advertising"], date: new Date(day + "T00:00:00Z"), amount: Math.round(between(2500, 5200) * k) });
    }
    await prisma.expense.createMany({ data: exp });
  }

  // Lifetime player figures.
  await prisma.$executeRawUnsafe(`
    UPDATE \`Player\` p LEFT JOIN (
      SELECT playerId, SUM(CASE WHEN type = 'DEPOSIT' THEN amount ELSE 0 END) AS dt, SUM(type = 'DEPOSIT') AS dc,
             SUM(CASE WHEN type = 'WITHDRAW' THEN amount ELSE 0 END) AS wt, SUM(type = 'WITHDRAW') AS wc,
             MIN(CASE WHEN type = 'DEPOSIT' THEN txnAt END) AS fd, MAX(CASE WHEN type = 'DEPOSIT' THEN txnAt END) AS ld
      FROM \`Txn\` GROUP BY playerId) s ON s.playerId = p.id
    SET p.depositTotal = COALESCE(s.dt, 0), p.depositCount = COALESCE(s.dc, 0), p.withdrawTotal = COALESCE(s.wt, 0),
        p.withdrawCount = COALESCE(s.wc, 0), p.firstDepositAt = s.fd, p.lastDepositAt = s.ld`);

  // Who typed each record in (Siti and Aina for Brand A, Aina and the admin for the others), a few minutes after it happened.
  const admin = await prisma.user.findFirstOrThrow({ where: { role: { name: "Administrator" } }, orderBy: { id: "asc" } });
  const by = (id: string, brand: string) =>
    `IF(${brand} = ${brands[0].id}, IF(${id} % 10 < 7, ${staff.siti.id}, ${staff.aina.id}), IF(${id} % 4 < 3, ${staff.aina.id}, ${admin.id}))`;
  const ids = brands.map((b) => b.id).join(",");
  await prisma.$executeRawUnsafe(
    `UPDATE \`Txn\` SET createdById = ${by("id", "brandId")}, createdAt = LEAST(UTC_TIMESTAMP(), txnAt + INTERVAL (3 + id * 37 % 88) MINUTE) WHERE brandId IN (${ids})`,
  );
  await prisma.$executeRawUnsafe(
    `UPDATE \`PromoClaim\` c JOIN \`Promotion\` p ON p.id = c.promotionId
     SET c.createdById = ${by("c.id", "p.brandId")}, c.createdAt = LEAST(UTC_TIMESTAMP(), c.claimedAt + INTERVAL (3 + c.id * 37 % 88) MINUTE) WHERE p.brandId IN (${ids})`,
  );
  await prisma.$executeRawUnsafe(
    `UPDATE \`Expense\` SET createdById = IF(id % 2 = 0, ${staff.aina.id}, ${admin.id}), createdAt = LEAST(UTC_TIMESTAMP(), date + INTERVAL (120 + id * 13 % 300) MINUTE) WHERE brandId IN (${ids})`,
  );

  // CS follow-ups on players who went quiet, some of whom came back.
  const quiet = await prisma.player.findMany({ where: { lastDepositAt: { lt: at(7) }, depositCount: { gt: 2 } }, orderBy: { depositTotal: "desc" }, take: 120 });
  const cs = [staff.mei, staff.jason];
  for (const [i, p] of quiet.entries()) {
    if (rnd() < 0.35) continue;
    const who = p.brandId === brands[2].id ? staff.jason : cs[i % 2];
    const when = new Date(p.lastDepositAt!.getTime() + between(7, 12) * 86400_000);
    if (when > new Date()) continue;
    await prisma.contactLog.create({
      data: {
        playerId: p.id,
        staffId: who.id,
        channel: pick(["WhatsApp", "WhatsApp", "Telegram", "SMS", "Phone call"]),
        bonus: rnd() < 0.5 ? Math.round(between(10, 50)) : 0,
        contactedAt: when,
        replied: rnd() < 0.55,
        result: pick(["Will deposit this weekend", "Busy, try next week", "No reply yet", "Asked about bonus", "Not interested"]),
      },
    });
    await prisma.player.update({ where: { id: p.id }, data: { assignedToId: who.id } });
    // About a third come back within a few days.
    if (rnd() < 0.35) {
      const back = new Date(when.getTime() + between(1, 5) * 86400_000);
      if (back < new Date())
        await prisma.txn.create({ data: { brandId: p.brandId, playerId: p.id, type: "DEPOSIT", amount: Math.round(between(100, 600)), txnAt: back, channelId: fpay.id } });
    }
  }
  await prisma.$executeRawUnsafe(`
    UPDATE \`Player\` p JOIN (
      SELECT playerId, SUM(CASE WHEN type = 'DEPOSIT' THEN amount ELSE 0 END) AS dt, SUM(type = 'DEPOSIT') AS dc,
             MAX(CASE WHEN type = 'DEPOSIT' THEN txnAt END) AS ld
      FROM \`Txn\` GROUP BY playerId) s ON s.playerId = p.id
    SET p.depositTotal = s.dt, p.depositCount = s.dc, p.lastDepositAt = s.ld`);

  // PGs settle the previous day's takings (after fees) to the bank every morning; the owner takes money out on the 1st.
  const pgDays = await prisma.$queryRawUnsafe<{ id: number; d: string; net: unknown }[]>(`
    SELECT c.id, DATE_FORMAT(DATE_ADD(t.txnAt, INTERVAL 8 HOUR), '%Y-%m-%d') AS d, SUM(t.amount - (t.amount * c.feePercent / 100 + c.feeFixed)) AS net
    FROM \`Txn\` t JOIN \`PayChannel\` c ON c.id = t.channelId
    WHERE c.type = 'PG' AND t.type = 'DEPOSIT' GROUP BY c.id, d`);
  const moves: { channelId: number; kind: "TRANSFER_IN" | "TRANSFER_OUT" | "CASHOUT"; amount: number; at: Date; transferRef?: string; note: string; userName: string }[] = [];
  for (const r of pgDays) {
    const next = new Date(new Date(r.d + "T00:00:00Z").getTime() - OFFSET + 34 * 3600_000); // 10:00 the next day
    if (next > new Date()) continue;
    const net = Math.round(Number(r.net) * 100) / 100;
    const ref = `settle-${r.id}-${r.d}`;
    const name = r.id === fpay.id ? "FPay" : "SurePay";
    moves.push({ channelId: r.id, kind: "TRANSFER_OUT", amount: -net, at: next, transferRef: ref, note: `${name} settlement ${r.d}`, userName: "Aina" });
    moves.push({ channelId: maybank.id, kind: "TRANSFER_IN", amount: net, at: next, transferRef: ref, note: `${name} settlement ${r.d}`, userName: "Aina" });
  }
  for (let d = DAYS; d >= 0; d--)
    if (dayStr(d).endsWith("-01")) moves.push({ channelId: maybank.id, kind: "CASHOUT", amount: -80000, at: at(d, 15), note: "Owner withdrawal", userName: "Aina" });
  await prisma.channelMove.createMany({ data: moves });

  // Today's balance checks: most match, Maybank is short by 850, FPay was last checked two days ago, DBS never.
  const expected = async (channelId: number, when: Date) => {
    const [r] = await prisma.$queryRawUnsafe<{ bal: unknown }[]>(`
      SELECT c.openingBalance
        + COALESCE((SELECT SUM(CASE WHEN t.type = 'DEPOSIT' THEN t.amount - (t.amount * c.feePercent / 100 + c.feeFixed) ELSE -t.amount END)
                    FROM \`Txn\` t WHERE t.channelId = c.id AND t.txnAt >= c.openingAt AND t.txnAt <= ?), 0)
        + COALESCE((SELECT SUM(m.amount) FROM \`ChannelMove\` m WHERE m.channelId = c.id AND m.at >= c.openingAt AND m.at <= ?), 0) AS bal
      FROM \`PayChannel\` c WHERE c.id = ?`, when, when, channelId);
    return Math.round(Number(r.bal) * 100) / 100;
  };
  const nowish = new Date(Date.now() - 2 * 3600_000);
  const twoDaysAgo = new Date(Date.now() - 50 * 3600_000);
  for (const [acc, when, short] of [
    [surepay, nowish, 0],
    [maybank, nowish, 850],
    [fpay, twoDaysAgo, 0],
  ] as const) {
    const exp = await expected(acc.id, when);
    await prisma.balanceCheck.create({ data: { channelId: acc.id, at: when, expected: exp, actual: exp - short, userName: "Aina", resolved: short === 0 } });
  }

  // Shareholders and their shares.
  const [chen, lim, wong] = await Promise.all(["Mr. Chen", "Mr. Lim", "Mr. Wong"].map((name) => prisma.shareholder.create({ data: { name } })));
  const from = new Date(dayStr(DAYS + 30) + "T00:00:00Z");
  await prisma.holding.createMany({
    data: [
      { shareholderId: chen.id, brandId: brands[0].id, percent: 40, effectiveFrom: from },
      { shareholderId: lim.id, brandId: brands[0].id, percent: 35, effectiveFrom: from },
      { shareholderId: wong.id, brandId: brands[0].id, percent: 25, effectiveFrom: from },
      { shareholderId: chen.id, brandId: brands[1].id, percent: 30, effectiveFrom: from },
      { shareholderId: wong.id, brandId: brands[1].id, percent: 60, effectiveFrom: from },
      { shareholderId: lim.id, brandId: brands[2].id, percent: 50, effectiveFrom: from },
      { shareholderId: wong.id, brandId: brands[2].id, percent: 50, effectiveFrom: from },
    ],
  });

  const counts = await Promise.all([prisma.player.count(), prisma.txn.count(), prisma.channelMove.count(), prisma.promoClaim.count(), prisma.contactLog.count()]);
  if (!process.env.DEMO_PASSWORD) console.log(`Demo staff password: ${DEMO_PASSWORD}`);
  console.log(`Demo data loaded: ${counts[0]} players, ${counts[1]} transactions, ${counts[2]} account movements, ${counts[3]} claims, ${counts[4]} CS contacts.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
