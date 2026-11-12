"use client";

import { SettingsPage } from "@/components/admin/settings-list";

export default function AdminPaymentsPage() {
  return (
    <SettingsPage
      eyebrow="Money and daily running"
      title="Payments and bills"
      about="Tax rates, the advance, and the reminders about money."
      groups={[
        { title: "Tax", keys: ["billing.salesTaxRate", "billing.serviceChargeRate"] },
        { title: "How money is paid", keys: ["payment.banks"] },
        { title: "The advance", keys: ["advancePayment.reconciliation.alsoAllowed", "advancePayment.followUpWindowSeconds", "advancePayment.escalationWindowSeconds"] },
        { title: "After the stay and disputes", keys: ["payment.followUp.ttlDays", "dispute.sla", "fomOverride.frequency"] },
        { keys: ["payment.followUp.intervals", "invoice.templates", "invoice.templates.final", "invoice.templates.proforma", "proformaInvoice.templates"] },
      ]}
    />
  );
}
