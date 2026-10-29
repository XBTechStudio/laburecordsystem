// Deletes all business data — use before going live to remove demo data:
//   npm run demo:clear -- --yes
// Keeps: the "admin" account, roles, settings, expense/income categories and import templates.

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  if (!process.argv.includes("--yes")) {
    console.log("This deletes every brand, player, transaction, PG/bank account, balance check, expense, promotion, CS log, shareholder and settlement.");
    console.log("Run again with --yes to confirm:  npm run demo:clear -- --yes");
    return;
  }
  await prisma.$transaction([
    prisma.dividendPayment.deleteMany(),
    prisma.settlementLine.deleteMany(),
    prisma.settlement.deleteMany(),
    prisma.holding.deleteMany(),
    prisma.dividendRule.deleteMany(),
    prisma.shareholder.deleteMany(),
    prisma.alert.deleteMany(),
    prisma.promoAward.deleteMany(),
    prisma.promoProgress.deleteMany(),
    prisma.contactLog.deleteMany(),
    prisma.promoClaim.deleteMany(),
    prisma.promotion.deleteMany(),
    prisma.txn.deleteMany(),
    prisma.channelMove.deleteMany(),
    prisma.balanceCheck.deleteMany(),
    prisma.expense.deleteMany(),
    prisma.player.deleteMany(),
    prisma.importBatch.deleteMany(),
    prisma.savedReport.deleteMany(),
    prisma.payChannel.deleteMany(),
    prisma.userBrand.deleteMany(),
    prisma.session.deleteMany({ where: { user: { username: { not: "admin" } } } }),
    prisma.user.deleteMany({ where: { username: { not: "admin" } } }),
    prisma.brand.deleteMany(),
    prisma.auditLog.deleteMany(),
  ]);
  console.log("All business data deleted. The admin account, roles, settings, categories and import templates were kept.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
