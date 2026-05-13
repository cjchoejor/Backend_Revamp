/** Small explicit JSON shapes returned by some reservation routes (not full Prisma graphs). */

export type OkAckResponseDto = {
  ok: true;
};

export type FocGmApproveResponseDto = {
  ok: true;
  entryId: string;
};

export type CoordinatorConfirmResponseDto = {
  ok: true;
  entryId: string;
  workOrderId: string;
};

export type PaymentMilestoneScheduledItemDto = {
  milestone: string;
  timerRecordId: string;
  dueAt: string;
};

export type SchedulePaymentMilestonesResponseDto = {
  ok: true;
  entryId: string;
  scheduled: PaymentMilestoneScheduledItemDto[];
};
