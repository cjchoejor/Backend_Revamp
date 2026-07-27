import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
(async () => {
  const inquiries = await p.inquiry.findMany({ select: { id: true, notes: true, createdAt: true }, orderBy: { createdAt: "asc" } });
  const byRef = new Map<string, { id: string; notes: string | null; createdAt: Date }[]>();
  for (const inq of inquiries) {
    const m = (inq.notes ?? "").match(/Original reservation_ref_no: (RES_[\d_]+)/);
    const ref = m ? m[1] : "(no-ref)";
    if (!byRef.has(ref)) byRef.set(ref, []);
    byRef.get(ref)!.push(inq);
  }
  let dups = 0;
  const dupRefs: string[] = [];
  for (const [ref, rows] of byRef) {
    if (rows.length > 1) {
      console.log(`${ref} → ${rows.length} inquiries: ${rows.map((r) => r.id).join(", ")}`);
      dups++;
      dupRefs.push(ref);
    }
  }
  console.log(`\nTotal duplicate refs: ${dups}`);
  console.log(`Total inquiries: ${inquiries.length}`);
  console.log(`Unique refs: ${byRef.size}`);
  await p.$disconnect();
})();
