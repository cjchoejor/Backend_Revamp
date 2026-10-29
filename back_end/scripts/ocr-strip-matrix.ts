// The ID reader's rules (2026-10-29): the passport strip's check-digit repair, the shapes, a cut strip,
// the guards, and the citizenship card's recognition.
// Read-only, no database. Run: npx tsx scripts/ocr-strip-matrix.ts
import { extractMrzLines, parseMrzLines, repairTd3 } from "../src/lib/identity-ocr/mrz.js";
import { namesFromLine1, printedNumberLookalikes, readPassportFromText } from "../src/lib/identity-ocr/passport-text.js";
import { parseLayoutText } from "../src/lib/identity-ocr/layout-parse.js";

let fails = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra !== undefined ? " — " + JSON.stringify(extra) : ""}`);
};
const L1 = "P<INDJAIN<<PRAMOD<KUMAR<<<<<<<<<<<<<<<<<<<<<";
const L2 = "Z7286983<6IND6206022M33061383078078841223<12";

check("a clean strip is left as it is", JSON.stringify(repairTd3([L1, L2])) === JSON.stringify([L1, L2]));
check("Z read as 7 is put right", repairTd3([L1, "7" + L2.slice(1)])[1] === L2, repairTd3([L1, "7" + L2.slice(1)])[1]);
check("Z read as 1 is put right", repairTd3([L1, "1" + L2.slice(1)])[1] === L2);
check("an O in a date is a 0", repairTd3([L1, L2.slice(0, 13) + "62O6022" + L2.slice(20)])[1] === L2);
const p = parseMrzLines([L1, "7" + L2.slice(1)]);
check("…and the parse proves the number", p?.fields.documentNumber === "Z7286983" && p?.fieldConfidence.documentNumber === "VERIFIED", p?.fields);
check("…the names from the first line", p?.fields.fullName === "Pramod Kumar Jain");
// Two misreads in one field: no single change proves it — nothing is changed, and the number stays unproven.
const two = "77286988<6IND6206022M33061383078078841223<12";
check("two misreads in the number: nothing is guessed", repairTd3([L1, two])[1] === two && parseMrzLines([L1, two])?.fieldConfidence.documentNumber !== "VERIFIED");
// A wrong birth date that a look-alike cannot explain stays unproven.
const badDob = L2.slice(0, 13) + "6206032" + L2.slice(20);
check("a birth date no look-alike explains stays unproven", parseMrzLines([L1, badDob])?.fieldConfidence.dateOfBirth !== "VERIFIED");
// The second line with no "<<" is still paired with the first.
check("a second line with no fillers is paired", JSON.stringify(extractMrzLines(`noise\n${L1}\n${L2}\nL ETR`)) === JSON.stringify([L1, L2]));
// The nationality one letter off the issuing country.
const inp = L2.slice(0, 10) + "INP" + L2.slice(13);
check("INP on an Indian strip reads IND", parseMrzLines([L1, inp])?.fields.nationality === "IND");
// A cut first line.
check("a cut first line gives the names", namesFromLine1("NDGUPTA<<ANUJ<<<<<<<<<<<<<<<<<<<<<<<<<S", "IND") === "Anuj Gupta", namesFromLine1("NDGUPTA<<ANUJ<<<<<<<<<<<<<<<<<<<<<<<<<S", "IND"));
check("a misread start before the country code", namesFromLine1("FP<INDSINGH<<HARISHIV<<<<<<<<<<<<<<<<<<<<", "IND") === "Harishiv Singh");
check("a garbled line gives no names", namesFromLine1("NDGUPTA<<ANUJ<CCESRITRRRR<S<KRT<<RR", "IND") === null);
check("no surname: the given names alone", namesFromLine1("P<IND<<DEV<DUTT<<<<<<<<<<<<<<<<<<<<<<<<<<<<<", "IND") === "Dev Dutt");
// The printed number with its first letter read as a digit, proven by a cut strip's check digit.
check("10602591 offers I0602591", printedNumberLookalikes(["10602591"]).includes("I0602591"));
const cut = readPassportFromText(["NDGUPTA<<ANUJ<<<<<<<<<<<<<<<<<<<<<<<<<<<", "02591<9IND7606157M3505207E070991364625<60"], ["10602591", "15706719"], { isPassport: true });
check("a cut strip: the number from the page, proven", cut?.fields.documentNumber === "I0602591" && cut?.fieldConfidence.documentNumber === "VERIFIED", cut?.fields);
check("…the names from the cut line", cut?.fields.fullName === "Anuj Gupta");
check("…the dates proven", cut?.fieldConfidence.dateOfBirth === "VERIFIED" && cut?.fieldConfidence.expiryDate === "VERIFIED");
// A printed eight-digit number the check digit does not pick is never suggested.
const none = readPassportFromText(["02591<9IND7606157M3505207E070991364625<60"], ["12345678"], { isPassport: true });
check("an unproven eight-digit number is not suggested", !none?.fields.documentNumber, none?.fields.documentNumber);
// A Bhutanese citizenship card as the page reader read it (2026-10-29, operator's photo).
const card = parseLayoutText(["KINGDOM OF BHUTan", "BHUTAN", "/Citizenship Card", "Name:Dilip Bhandari", "Sex: Male", "Date of Birth:03/04/1997", "Citizenships ID No. 11811003547"]);
check("a citizenship card is a CID, with its number", card?.fields.documentType === "CID" && card?.fields.documentNumber === "11811003547", card?.fields);
check("…its name, birth date and sex", card?.fields.fullName === "Dilip Bhandari" && card?.fields.dateOfBirth === "1997-04-03" && card?.fields.gender === "M", card?.fields);
const permit = parseLayoutText(["KINGDOM OF BHUTAN", "DEPARTMENT OF IMMIGRATION", "WORK PERMIT", "Name: Ram Kumar", "Job Category: Driver"]);
check("a work permit is still a work permit", permit?.fields.documentType === "WORK_PERMIT", permit?.fields.documentType);
const unknown = parseLayoutText(["Some card", "Name: Test Person", "ID No. 12345678901"]);
check("an unknown card takes a number written after ID No.", unknown?.fields.documentNumber === "12345678901", unknown?.fields);
const bare = parseLayoutText(["Some card", "Name: Test Person", "12345678901"]);
check("…but never a bare number with no label", !bare?.fields.documentNumber, bare?.fields);
console.log(fails === 0 ? "ALL PASS" : `${fails} FAILED`);
process.exit(0);
