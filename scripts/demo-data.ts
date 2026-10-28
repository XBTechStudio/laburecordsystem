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

  const channels = await Promise.all([
    prisma.payChannel.create({ data: { name: "FPay", type: "PG", feePercent: 2, feeFixed: 0 } }),
    prisma.payChannel.create({ data: { name: "SurePay", type: "PG", feePercent: 1.8, feeFixed: 0.5 } }),
    prisma.payChannel.create({ data: { name: "Maybank 1234", type: "BANK", feePercent: 0, feeFixed: 0 } }),
  ]);

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
        txns.push({ brandId: brand.id, playerId: p.id, type: "DEPOSIT", amount: dep, txnAt: at(d), channelId: pick(channels).id });
        if (rnd() < 0.42) txns.push({ brandId: brand.id, playerId: p.id, type: "WITHDRAW", amount: Math.round(dep * between(0.6, 2.1)), txnAt: at(d, between(10, 24)), channelId: channels[2].id });
      }
    }
    for (let i = 0; i < txns.length; i += 2000) await prisma.txn.createMany({ data: txns.slice(i, i + 2000) });

    // PG / bank statements: match the back office, with a few days off.
    const flows = new Map<string, { inA: number; inC: number; outA: number; outC: number }>();
    for (const t of txns) {
      const day = new Date(t.txnAt.getTime() + OFFSET).toISOString().slice(0, 10);
      const key = `${t.channelId}|${day}`;
      const f = flows.get(key) ?? { inA: 0, inC: 0, outA: 0, outC: 0 };
      if (t.type === "DEPOSIT") {
        f.inA += t.amount;
        f.inC++;
      } else {
        f.outA += t.amount;
        f.outC++;
      }
      flows.set(key, f);
    }
    const flowRows = [...flows.entries()]
      .filter(([key]) => key.split("|")[1] < today) // today's statement isn't in yet
      .map(([key, f]) => {
        const [ch, day] = key.split("|");
        const c = channels.find((x) => x.id === Number(ch))!;
        const off = rnd() < 0.04 ? Math.round(between(80, 900) * k) : 0;
        return {
          brandId: brand.id,
          channelId: c.id,
          date: new Date(day + "T00:00:00Z"),
          inAmount: f.inA - off,
          inCount: f.inC - (off ? 1 : 0),
          outAmount: f.outA,
          outCount: f.outC,
          fee: Math.round(((f.inA - off) * Number(c.feePercent)) / 100 + f.inC * Number(c.feeFixed)),
        };
      });
    await prisma.channelFlow.createMany({ data: flowRows });

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
        await prisma.txn.create({ data: { brandId: p.brandId, playerId: p.id, type: "DEPOSIT", amount: Math.round(between(100, 600)), txnAt: back, channelId: channels[0].id } });
    }
  }
  await prisma.$executeRawUnsafe(`
    UPDATE \`Player\` p JOIN (
      SELECT playerId, SUM(CASE WHEN type = 'DEPOSIT' THEN amount ELSE 0 END) AS dt, SUM(type = 'DEPOSIT') AS dc,
             MAX(CASE WHEN type = 'DEPOSIT' THEN txnAt END) AS ld
      FROM \`Txn\` GROUP BY playerId) s ON s.playerId = p.id
    SET p.depositTotal = s.dt, p.depositCount = s.dc, p.lastDepositAt = s.ld`);

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

  const counts = await Promise.all([prisma.player.count(), prisma.txn.count(), prisma.channelFlow.count(), prisma.promoClaim.count(), prisma.contactLog.count()]);
  if (!process.env.DEMO_PASSWORD) console.log(`Demo staff password: ${DEMO_PASSWORD}`);
  console.log(`Demo data loaded: ${counts[0]} players, ${counts[1]} transactions, ${counts[2]} statement rows, ${counts[3]} claims, ${counts[4]} CS contacts.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
