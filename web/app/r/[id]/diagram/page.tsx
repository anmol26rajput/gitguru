import Diagram from "@/components/Diagram";

export default async function DiagramPage({ params }: PageProps<"/r/[id]/diagram">) {
  const { id } = await params;
  return <Diagram repoId={Number(id)} />;
}
