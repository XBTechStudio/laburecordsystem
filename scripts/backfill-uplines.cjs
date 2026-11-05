// One-off: fills Player.uplineExtId (the platform's referrerId) for players we already have.
// New players get it from the platform sync. Must run on the server (the platform only answers its IP):
//   cd /www/wwwroot/70.xbtech.my && node scripts/backfill-uplines.cjs [brandId]
// Reads every member page slowly (about 3 calls a second) so the live sync stays under the platform's limit.
const fs = require("fs");
for (const l of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const key = () => crypto.createHash("sha256").update(`secret-box:${process.env.AUTH_SECRET ?? ""}`).digest();
const open = (s) => {
  const [iv, tag, body] = s.split(".").map((x) => Buffer.from(x, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(link, token, pageIndex) {
  for (let tries = 0; ; tries++) {
    try {
      await sleep(330);
      const body = new URLSearchParams({ module: "/users/getAllUsers", merchantId: link.merchantId, accessId: link.accessId, accessToken: token, sortBy: "register", sortType: "DESC", pageIndex: String(pageIndex) });
      const r = await (await fetch(link.apiUrl, { method: "POST", body, signal: AbortSignal.timeout(30000) })).json();
      if (r.status !== "SUCCESS") throw new Error(JSON.stringify(r).slice(0, 200));
      return r.data ?? r;
    } catch (e) {
      if (tries >= 4) throw e;
      console.log(`  page ${pageIndex} failed (${e.message}), retrying`);
      await sleep(5000 * (tries + 1));
    }
  }
}

(async () => {
  const only = process.argv[2] ? Number(process.argv[2]) : null;
  const links = await prisma.platformLink.findMany({ where: { enabled: true, ...(only ? { brandId: only } : {}) } });
  for (const link of links) {
    const token = open(link.tokenEnc);
    const ups = new Map(); // upline extId → member extIds
    let total = null;
    let seen = 0;
    for (let p = 0; total == null || p < total; p++) {
      const d = await page(link, token, p);
      total = d.totalPage ?? 0;
      for (const u of d.users ?? []) {
        seen++;
        if (!u.referrerId) continue;
        const k = String(u.referrerId).slice(0, 40);
        (ups.get(k) ?? ups.set(k, []).get(k)).push(String(u.id));
      }
      if (p % 50 === 0) console.log(`brand ${link.brandId}: page ${p + 1}/${total}`);
      if (!(d.users ?? []).length) break;
    }
    let updated = 0;
    for (const [up, ids] of ups) {
      for (let i = 0; i < ids.length; i += 500) {
        const part = ids.slice(i, i + 500);
        updated += await prisma.$executeRawUnsafe(
          `UPDATE \`Player\` SET uplineExtId = ? WHERE brandId = ? AND extId IN (${part.map(() => "?").join(",")}) AND (uplineExtId IS NULL OR uplineExtId <> ?)`,
          up,
          link.brandId,
          ...part,
          up,
        );
      }
    }
    console.log(`brand ${link.brandId}: ${seen} members read, ${[...ups.values()].reduce((a, x) => a + x.length, 0)} with an upline, ${updated} players updated`);
  }
  await prisma.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
