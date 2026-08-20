"use client";

import { ConfirmationDialog } from "@/components/ui/ConfirmDialog";

type UnsavedChangesDialogProps = {
  open: boolean;
  onKeepEditing: () => void;
  onDiscard: () => void;
};

export default function UnsavedChangesDialog({
  open,
  onKeepEditing,
  onDiscard,
}: UnsavedChangesDialogProps) {
  if (!open) return null;

  return (
    <ConfirmationDialog
      kicker="修改未保存"
      title="还有修改没有保存"
      description="离开后，本次修改将无法恢复。你可以继续编辑，或者放弃这些修改。"
      cancelLabel="继续编辑"
      confirmLabel="放弃修改"
      tone="warning"
      onCancel={onKeepEditing}
      onConfirm={onDiscard}
    />
  );
}
