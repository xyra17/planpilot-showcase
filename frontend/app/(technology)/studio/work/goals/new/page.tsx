"use client";

import { useRouter } from "next/navigation";

import { GoalCreateDialog } from "@/components/goal/GoalCreateDialog";
import TechnologyGoalsPage from "../page";

export default function TechnologyNewGoalPage() {
  const router = useRouter();
  return (
    <>
      <TechnologyGoalsPage />
      <div className="tech-goal-route-modal">
        <GoalCreateDialog onClose={() => router.replace("/studio/work/goals")} />
      </div>
    </>
  );
}
