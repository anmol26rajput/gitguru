import { Suspense } from "react";
import RepoList from "@/components/RepoList";

export default function Home() {
  return (
    <Suspense>
      <RepoList />
    </Suspense>
  );
}
