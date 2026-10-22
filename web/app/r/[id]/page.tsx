import Chat from "@/components/Chat";

export default async function RepoPage({ params }: PageProps<"/r/[id]">) {
  const { id } = await params;
  return <Chat repoId={Number(id)} />;
}
