import RepoTabs from "@/components/RepoTabs";

export default async function RepoLayout({ children, params }: LayoutProps<"/r/[id]">) {
  const { id } = await params;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RepoTabs repoId={Number(id)} />
      {children}
    </div>
  );
}
