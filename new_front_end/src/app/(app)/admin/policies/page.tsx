"use client";

import { Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { SettingsList, SettingsPageHead } from "@/components/admin/settings-list";
import { POLICIES, POLICY_GROUPS, getSettingDef } from "@/lib/admin/setting-forms";
import { listPolicies } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";

export default function AdminHouseRulesPage() {
  const { session } = useSession();
  const query = useQuery({
    queryKey: ["admin", "policies"],
    queryFn: () => listPolicies(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  // A rule on file that no form is written for still shows, with its value in words.
  const others = (query.data?.items ?? []).filter((p) => p.isActive && !getSettingDef(p.policyId)).map((p) => p.policyId);

  return (
    <div className="set-page">
      <SettingsPageHead
        eyebrow="Rules"
        title="House rules"
        about="The hotel's rules. Saving keeps the old version on file and starts a new one. A rule that is off gives way to the setting behind it, where there is one. Rules built into the system are not here: only a developer can change those."
      />
      <Suspense>
        <SettingsList
          groups={[
            ...POLICY_GROUPS.map((g) => ({ title: g, keys: POLICIES.filter((p) => p.group === g).map((p) => p.key) })),
            { title: "Others on file", keys: others },
          ]}
        />
      </Suspense>
    </div>
  );
}
