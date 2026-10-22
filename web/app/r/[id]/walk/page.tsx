import Walkthrough from "@/components/Walkthrough";

export default async function WalkPage({ params }: PageProps<"/r/[id]/walk">) {
  const { id } = await params;
  return <Walkthrough repoId={Number(id)} />;
}
