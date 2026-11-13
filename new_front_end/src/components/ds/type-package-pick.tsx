"use client";

/**
 * Which of the booking's chosen packages prices a room type (2026-11-13, operator: "when user picks
 * each room type, they can have like a dropdown option to select which package rate goes to that
 * room"). Saved on the stay as soon as it is picked; every price on the desk is read again from the
 * server — the S1 bill, the rate strip, the live table and the Package tab — so nothing is worked out
 * here. Shown only when the booking has more than one package.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { getRateReference, setRoomTypePackage } from "@/lib/api/entries";
import { toastRefusal } from "@/components/ds/steps/kit";
import type { EntryDetail } from "@/types/api";

/** The booking's chosen packages, by name, and whether a type's package may still be changed. */
export function useBookingPackages(entryId: string) {
  const { session } = useSession();
  const q = useQuery({
    queryKey: ["rate-reference", entryId],
    queryFn: () => getRateReference(session!, entryId),
    enabled: !!session,
    staleTime: 30_000,
  });
  return { packages: q.data?.packages ?? [], editable: !!q.data?.packagesEditable };
}

/** The package a type is on: the stay's choice when it is still chosen, else the first. */
export function packageOfType(entry: Pick<EntryDetail, "ratePackageByRoomType">, packages: Array<{ id: string }>, roomTypeId: string): string | null {
  const id = (entry.ratePackageByRoomType ?? {})[roomTypeId];
  return id && packages.some((p) => p.id === id) ? id : (packages[0]?.id ?? null);
}

export function TypePackagePick({
  entryId,
  roomTypeId,
  typeName,
  packages,
  value,
  editable,
}: {
  entryId: string;
  roomTypeId: string;
  typeName: string;
  packages: Array<{ id: string; name: string }>;
  value: string | null;
  editable: boolean;
}) {
  const { session } = useSession();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (ratePackageId: string) => setRoomTypePackage(session!, entryId, { roomTypeId, ratePackageId }),
    onSuccess: (r, ratePackageId) => {
      if (r.changed) toast.success(`${typeName} is now priced on ${packages.find((p) => p.id === ratePackageId)?.name ?? "that package"}`);
      for (const k of [["entry", entryId], ["rate-reference", entryId], ["price-pick", entryId], ["price-pick-trip"], ["quotation-preview"], ["quotation-live-preview"], ["rate-sheet"], ["billing-summary", entryId]]) {
        void qc.invalidateQueries({ queryKey: k });
      }
    },
    onError: (e) => toastRefusal(e, `${typeName}'s package could not be changed`),
  });
  const name = packages.find((p) => p.id === value)?.name ?? "—";
  if (!editable) return <span className="type-pkg ro">{name}</span>;
  return (
    <select
      className="input type-pkg"
      aria-label={`${typeName}: rate package`}
      value={value ?? ""}
      disabled={m.isPending}
      onChange={(e) => m.mutate(e.target.value)}
    >
      {packages.map((p, i) => (
        <option key={p.id} value={p.id} title={i === 0 ? "The first package: it prices any room type left alone" : undefined}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

/**
 * The package of each room type chosen, on one line — The house when its rooms were picked by number
 * (the by-type grid has a Package column of its own). Nothing with one package.
 */
export function TypePackagesLine({
  entry,
  types,
  editable,
}: {
  entry: Pick<EntryDetail, "id" | "ratePackageByRoomType">;
  types: Array<{ roomTypeId: string; name: string }>;
  editable: boolean;
}) {
  const booking = useBookingPackages(entry.id);
  if (booking.packages.length < 2 || types.length === 0) return null;
  return (
    <div className="type-pkg-line">
      <span className="rce-lbl">Packages</span>
      {types.map((t) => (
        <span key={t.roomTypeId} className="type-pkg-item">
          {t.name}
          <TypePackagePick
            entryId={entry.id}
            roomTypeId={t.roomTypeId}
            typeName={t.name}
            packages={booking.packages}
            value={packageOfType(entry, booking.packages, t.roomTypeId)}
            editable={editable && booking.editable}
          />
        </span>
      ))}
    </div>
  );
}
