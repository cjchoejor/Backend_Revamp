"use client";

/**
 * Change the guest's name, phone and email, and the tag, from the booking file (2026-11-25, operator:
 * "in the right panel, we need an option to change the guest name, number, email — make sure it's
 * well audited"; "also to edit the tag as well").
 *
 * The guest's record is shared by every booking the guest has, so the box says which other bookings
 * the change reaches before the save, and says when the new number or email is already on another
 * guest's record. The save (`POST /entries/:id/guest/details`) keeps the record before it whole and
 * writes the change into the History of every booking it reaches. The tag is the enquiry's and saves
 * itself when its field is left (`INQUIRY.DESK_TAG_SET`).
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { usePhoneRules } from "@/hooks/use-phone-rules";
import { ApiError } from "@/lib/api/client";
import { correctGuestDetails, findGuestsOnFile } from "@/lib/api/guest-profiles";
import { listSameGuestBookings } from "@/lib/api/guest-bookings";
import { problemOfPhone } from "@/lib/ds/phone";
import { fullNameOf } from "@/lib/ds/person";
import { fmtDmy, plural } from "@/lib/ds/format";
import { PersonName } from "@/components/ds/person-name";
import { PhoneField } from "@/components/ds/phone-field";
import { useInquiryDeskTag } from "@/components/ds/desk-tag";
import { DsDialog } from "@/components/ds/steps/kit";
import type { EntryDetail } from "@/types/api";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const digits = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");

export function GuestDetailsDialog({ entry, open, onClose }: { entry: EntryDetail; open: boolean; onClose: () => void }) {
  const { session } = useSession();
  const qc = useQueryClient();
  const phoneRules = usePhoneRules();
  const g = entry.guestProfile ?? null;
  const saved = {
    title: g?.title?.trim() ?? "",
    name: fullNameOf(g?.firstName, g?.lastName),
    phone: g?.phone ?? "",
    email: g?.email ?? "",
  };
  const [title, setTitle] = useState(saved.title);
  const [name, setName] = useState(saved.name);
  const [phone, setPhone] = useState(saved.phone);
  const [email, setEmail] = useState(saved.email);
  const [busy, setBusy] = useState(false);
  const tag = useInquiryDeskTag(entry.inquiry?.id, entry.inquiry?.deskTag ?? null, entry.id);
  useEffect(() => {
    if (!open) return;
    setTitle(saved.title);
    setName(saved.name);
    setPhone(saved.phone);
    setEmail(saved.email);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seeded when the box opens
  }, [open]);

  const nameChanged = title.trim() !== saved.title || name.trim().replace(/\s+/g, " ") !== saved.name;
  const phoneChanged = digits(phone) !== digits(saved.phone);
  const emailChanged = email.trim() !== saved.email.trim();
  const changed = nameChanged || phoneChanged || emailChanged;
  const phoneBad = phone.trim() ? problemOfPhone(phoneRules, phone) : null;
  const emailBad = email.trim() && !EMAIL.test(email.trim()) ? "that does not read as an email address" : null;
  const nameEmpty = !name.trim();

  // Which other bookings share this guest's record — the change shows on each of them.
  const sharing = useQuery({
    queryKey: ["guest-bookings", entry.id],
    queryFn: () => listSameGuestBookings(session!, entry.id),
    enabled: open && !!session && !!g?.id,
    staleTime: 30_000,
  });
  const others = sharing.data?.bookings ?? [];
  const liveOthers = others.filter((b) => b.live);

  // The new number or email on another guest's record — said, not refused.
  const lookPhone = phoneChanged && phone.trim() && !phoneBad ? phone.trim() : "";
  const lookEmail = emailChanged && email.trim() && !emailBad ? email.trim() : "";
  const onFile = useQuery({
    queryKey: ["guests-on-file", "exact", lookPhone, lookEmail],
    queryFn: () => findGuestsOnFile(session!, { phone: lookPhone || undefined, email: lookEmail || undefined, exact: true }),
    enabled: open && !!session && !!(lookPhone || lookEmail),
    staleTime: 30_000,
  });
  const alsoOnFile = useMemo(() => (onFile.data?.guests ?? []).filter((x) => x.id !== g?.id), [onFile.data, g?.id]);

  const why = !changed
    ? "Nothing has changed"
    : nameEmpty
      ? "The name cannot be empty"
      : phoneBad
        ? `The phone: ${phoneBad}`
        : emailBad
          ? `The email: ${emailBad}`
          : null;

  const save = async () => {
    if (!session || why) return;
    setBusy(true);
    try {
      const out = await correctGuestDetails(session, entry.id, {
        ...(nameChanged ? { title: title.trim() || null, name: name.trim() } : {}),
        ...(phoneChanged ? { phone: phone.trim() || null } : {}),
        ...(emailChanged ? { email: email.trim() || null } : {}),
      });
      for (const k of [["entry", entry.id], ["entry"], ["desk-bookings"], ["entry-trace", entry.id], ["guest-bookings", entry.id], ["room-chart"]]) {
        void qc.invalidateQueries({ queryKey: k });
      }
      const live = out.sharedWith.filter((s) => s.live).length;
      toast.success("The guest's details are changed", {
        description: [
          live ? `Also on ${plural(live, "other live booking")} — said in each one's History.` : null,
          out.arrivingUpdated.length ? "Who is arriving follows." : null,
          out.alsoOnFile.length ? `The same ${out.alsoOnFile[0].matchedBy.includes("PHONE") ? "number" : "email"} is on file for ${out.alsoOnFile.map((x) => x.name).join(", ")}.` : null,
        ]
          .filter(Boolean)
          .join(" "),
      });
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The guest's details were not changed");
    } finally {
      setBusy(false);
    }
  };

  const lines: string[] = [];
  if (nameChanged) lines.push(`Name: ${[saved.title, saved.name].filter(Boolean).join(" ") || "—"} → ${[title.trim(), name.trim()].filter(Boolean).join(" ") || "—"}`);
  if (phoneChanged) lines.push(`Phone: ${saved.phone || "none"} → ${phone.trim() || "none"}`);
  if (emailChanged) lines.push(`Email: ${saved.email || "none"} → ${email.trim() || "none"}`);

  return (
    <DsDialog
      open={open}
      onClose={onClose}
      closeX
      width={640}
      title="The guest's details"
      help="A correction of the guest's own record: their name, phone and email. The record is shared by every booking the guest has, so the change shows on each, and each booking's History says it — with the old and new details and who changed them. The record before it is kept. Papers already made keep what they printed. The tag is the desk's own note and saves itself."
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            kind="primary"
            className={why ? undefined : "go"}
            state={busy ? "working" : why ? "inert" : "default"}
            reason={why ?? undefined}
            workingLabel="Saving…"
            onClick={() => void save()}
          >
            Save the changes
          </Button>
        </>
      }
    >
      <div className="guest-edit">
        <PersonName
          title={title}
          name={name}
          onTitle={setTitle}
          onName={setName}
          required={nameEmpty}
          tag={{ value: tag.value, onChange: tag.onChange, onCommit: tag.commit, state: tag.state }}
        />
        <div className="form2">
          <div className="field">
            <label>Phone</label>
            <PhoneField value={phone} onChange={setPhone} />
            {phoneBad ? <span className="hint stop-ink">{phoneBad}</span> : null}
          </div>
          <div className="field">
            <label>Email</label>
            <input className="input" type="email" value={email} placeholder="name@example.com" onChange={(e) => setEmail(e.target.value)} />
            {emailBad ? <span className="hint stop-ink">{emailBad}</span> : null}
          </div>
        </div>
        {alsoOnFile.length ? (
          <p className="warn-ink sm guest-edit-note" role="status">
            Also on file for {alsoOnFile.map((x) => [x.title, x.firstName, x.lastName].filter(Boolean).join(" ")).join(", ")} — that is another guest&rsquo;s record, and
            it stays as it is.
          </p>
        ) : null}
        {lines.length ? (
          <div className="guest-edit-changes" role="status">
            <b>What changes</b>
            {lines.map((l) => (
              <span key={l}>{l}</span>
            ))}
          </div>
        ) : null}
        {others.length ? (
          <div className="guest-edit-sharing">
            <b>
              This guest is also on {plural(others.length, "other booking")}
              {liveOthers.length && liveOthers.length !== others.length ? ` (${liveOthers.length} live)` : ""} — the change shows there too
            </b>
            {others.slice(0, 5).map((b) => (
              <span key={b.entryId} className="meta">
                {b.entryId} · {b.checkInDate ? fmtDmy(b.checkInDate.slice(0, 10)) : "no dates"} · {b.live ? b.stageWord : "ended"}
              </span>
            ))}
            {others.length > 5 ? <span className="meta">and {others.length - 5} more</span> : null}
          </div>
        ) : null}
      </div>
    </DsDialog>
  );
}
