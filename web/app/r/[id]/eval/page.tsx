import EvalDashboard from "@/components/EvalDashboard";

export default async function EvalPage({ params }: PageProps<"/r/[id]/eval">) {
  const { id } = await params;
  return <EvalDashboard repoId={Number(id)} />;
}
