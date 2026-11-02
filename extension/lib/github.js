// Mirrors the backend's normalize_github: any page of a repo maps to https://github.com/owner/repo.
// Top-level paths that look like owner/name but are GitHub's own pages.
const RESERVED = new Set([
  "about", "account", "apps", "codespaces", "collections", "contact", "copilot", "dashboard", "enterprise",
  "events", "explore", "features", "gist", "issues", "join", "login", "logout", "marketplace", "new",
  "notifications", "orgs", "organizations", "pricing", "pulls", "readme", "search", "security", "sessions",
  "settings", "signup", "site", "sitemap", "solutions", "sponsors", "stars", "team", "topics", "trending", "users", "watching",
]);

export function repoFromUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || !/^(www\.)?github\.com$/i.test(u.hostname)) return null;
  const [owner, name] = u.pathname.split("/").filter(Boolean);
  if (!owner || !name || RESERVED.has(owner.toLowerCase())) return null;
  const repo = name.replace(/\.git$/, "");
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo) || /^\.+$/.test(repo)) return null;
  return `https://github.com/${owner}/${repo}`;
}
