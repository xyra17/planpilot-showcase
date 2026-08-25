import AgentOperationsPage from "@/app/(admin)/admin/_components/AgentOperationsPage";
import { ModelRuntimeSettings } from "@/components/admin/ModelRuntimeSettings";

export default function AdminGatewayPage() {
  return <div className="grid gap-5"><ModelRuntimeSettings /><AgentOperationsPage /></div>;
}
