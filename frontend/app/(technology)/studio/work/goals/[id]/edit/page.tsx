"use client";

import { useParams, useRouter } from "next/navigation";

import { GoalEditDialog } from "@/components/goal/GoalEditDialog";

export default function EditGoalPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  return (
    <GoalEditDialog
      goalId={params.id}
      onClose={() => router.replace(`/studio/work/goals/${params.id}`)}
    />
  );
}
