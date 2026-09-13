import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSystemHealth } from "../health/SystemHealthContext";

interface RouteState { path: string; search: string; navigate: (path: string) => void; }

type IconName = "overview" | "assistant" | "cases" | "live" | "import" | "status";
type NavItem = { path: string; label: string; icon: IconName };

const investigationNav: NavItem[] = [
  { path: "/", label: "Overview", icon: "overview" },
  { path: "/assistant", label: "Investigation Assistant", icon: "assistant" },
  { path: "/cases", label: "Cases", icon: "cases" },
];
const operationsNav: NavItem[] = [
  { path: "/live", label: "Live Monitor", icon: "live" },
  { path: "/import", label: "Import Evidence", icon: "import" },
];
const systemNav: NavItem[] = [
  { path: "/status", label: "System Status", icon: "status" },
];

function NavIcon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
    assistant: <><path d="M5.5 17.5 4 21l3.8-1.4A8.5 8.5 0 1 0 5.5 17.5Z"/><path d="m12 7 .55 1.45L14 9l-1.45.55L12 11l-.55-1.45L10 9l1.45-.55L12 7ZM16.5 11.5l.38 1.12 1.12.38-1.12.38-.38 1.12-.38-1.12L15 13l1.12-.38.38-1.12ZM8 12h2"/></>,
    cases: <><path d="M4 7.5h16v11A2.5 2.5 0 0 1 17.5 21h-11A2.5 2.5 0 0 1 4 18.5v-11Z"/><path d="M9 7.5V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2.5M4 12h16M10 12v2h4v-2"/></>,
    live: <><path d="M5.6 18.4a9 9 0 0 1 0-12.8M8.5 15.5a5 5 0 0 1 0-7M18.4 5.6a9 9 0 0 1 0 12.8M15.5 8.5a5 5 0 0 1 0 7"/><circle cx="12" cy="12" r="2"/></>,
    import: <><path d="M12 15V3M7.5 7.5 12 3l4.5 4.5M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/></>,
    status: <><path d="M3 12h4l2.2-5 4.1 10 2.2-5H21"/><path d="M20 7a9 9 0 1 0 .5 9"/></>,
  };
  return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function canonicalLocation(path: string, search: string) {
  const legacyAssistant = path.match(/^\/cases\/(\d+)\/assistant$/);
  if (!legacyAssistant) return { path, search };
  const params = new URLSearchParams(search);
  params.set("case", decodeURIComponent(legacyAssistant[1]));
  return { path: "/assistant", search: `?${params.toString()}` };
}

export function useLocationPath() {
  const [location, setLocation] = useState(() => canonicalLocation(window.location.pathname, window.location.search));
  useLayoutEffect(() => {
    const current = `${window.location.pathname}${window.location.search}`;
    const canonical = `${location.path}${location.search}`;
    if (current !== canonical) window.history.replaceState(window.history.state, "", canonical);
  }, [location]);
  useEffect(() => {
    const update = () => setLocation(canonicalLocation(window.location.pathname, window.location.search));
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  const navigate = (next: string) => {
    const target = new URL(next, window.location.origin);
    const canonical = canonicalLocation(target.pathname, target.search);
    const destination = `${canonical.path}${canonical.search}${target.hash}`;
    window.history.pushState({}, "", destination);
    setLocation(canonical);
    if (!navigator.userAgent.includes("jsdom")) window.scrollTo({ top: 0, behavior: "smooth" });
  };
  return { path: location.path, search: location.search, navigate };
}

function Breadcrumbs({ path, navigate }: { path: string; navigate: (path: string) => void }) {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "cases" && parts[1]) {
    const section = parts[2] ? parts[2].charAt(0).toUpperCase() + parts[2].slice(1) : "Overview";
    return <div className="breadcrumbs"><button onClick={() => navigate("/cases")}>Cases</button><span>/</span><button onClick={() => navigate(`/cases/${parts[1]}/overview`)}>CASE-{parts[1].padStart(4, "0")}</button><span>/</span><b>{section}</b></div>;
  }
  const labels: Record<string, string> = { "/": "Overview", "/assistant": "Investigation Assistant", "/cases": "Cases", "/live": "Live Monitor", "/import": "Import Evidence", "/status": "System Status" };
  return <div className="breadcrumbs breadcrumbs-single"><b>{labels[path] || "Traceveil"}</b></div>;
}

export function AppShell({ children, route }: { children: ReactNode; route: RouteState }) {
  const health = useSystemHealth();
  const [collapsed, setCollapsed] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const activeFor = (path: string) => path === "/" ? route.path === "/" : route.path.startsWith(path);
  const targets = useMemo(() => [
    { label: "Investigation Assistant", detail: "Central evidence-grounded workspace", path: "/assistant", kind: "Workspace" },
    { label: "Cases", detail: "Investigation register", path: "/cases", kind: "Workspace" },
    { label: "Live Monitor", detail: "Current controlled activity", path: "/live", kind: "Workspace" },
    { label: "Import Evidence", detail: "Historical and batch evidence", path: "/import", kind: "Workspace" },
    { label: "System Status", detail: "Platform health", path: "/status", kind: "Platform" },
  ], []);
  const results = targets.filter(item => `${item.label} ${item.detail} ${item.kind}`.toLowerCase().includes(search.toLowerCase())).slice(0, 7);
  const selectTarget = (path: string) => { route.navigate(path); setSearch(""); setSearchOpen(false); };

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSearchOpen(true); searchRef.current?.focus(); }
      if (event.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("keydown", shortcut); return () => window.removeEventListener("keydown", shortcut);
  }, []);

  const renderNav = (items: NavItem[]) => <nav>{items.map(item => <button key={item.path} data-label={item.label} aria-label={item.label} aria-current={activeFor(item.path) ? "page" : undefined} className={activeFor(item.path) ? "active" : ""} onClick={() => { route.navigate(item.path); setMobile(false); }}><span className="nav-icon-wrap"><NavIcon name={item.icon}/>{item.icon === "live" && <i className="nav-live-dot"/>}</span><b>{item.label}</b></button>)}</nav>;

  return <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
    <aside className={`sidebar ${mobile ? "mobile-open" : ""}`}>
      <button className="brand" onClick={() => route.navigate("/")} aria-label="Traceveil overview">
        <span className="brand-emblem"><img className="brand-logo brand-logo-dark" src="/traceveil-logo-dark.png" alt=""/><img className="brand-logo brand-logo-transparent" src="/traceveil-logo-glow.png" alt=""/></span>
        <span className="brand-copy"><strong className="brand-wordmark">Trace<em>veil</em></strong><small>IoT digital forensics</small></span>
      </button>
      <div className="nav-groups">
        <section className="nav-section" aria-label="Investigation navigation"><div className="nav-label">Investigation</div>{renderNav(investigationNav)}</section>
        <section className="nav-section" aria-label="Operations navigation"><div className="nav-label">Operations</div>{renderNav(operationsNav)}</section>
        <section className="nav-section" aria-label="System navigation"><div className="nav-label">System</div>{renderNav(systemNav)}</section>
      </div>
      <div className="sidebar-footer">
        <div className="investigator-profile"><span>IN</span><div><b>Investigator</b><small>Local workspace</small></div><button aria-label="Profile options">•••</button></div>
        <div className="sidebar-collapse-area"><button className="collapse-button" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={collapsed ? "m9 18 6-6-6-6" : "m15 18-6-6 6-6"}/></svg></button></div>
      </div>
    </aside>
    <div className="app-main">
      <header className="topbar">
        <button className="mobile-menu" onClick={() => setMobile(!mobile)} aria-label="Open navigation">☰</button>
        <Breadcrumbs path={route.path} navigate={route.navigate}/>
        <div className="top-actions">
          <div className={`global-search ${searchOpen ? "open" : ""}`}>
            <span className="search-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg></span><input ref={searchRef} value={search} onFocus={() => setSearchOpen(true)} onChange={event => { setSearch(event.target.value); setSearchOpen(true); }} placeholder="Search cases, evidence, devices…" aria-label="Global search"/><kbd>Ctrl/⌘ K</kbd>
            {searchOpen && <div className="command-results" role="listbox">{results.length ? results.map(item => <button role="option" aria-selected="false" key={`${item.kind}-${item.label}`} onMouseDown={event => event.preventDefault()} onClick={() => selectTarget(item.path)}><span><b>{item.label}</b><small>{item.detail}</small></span><em>{item.kind}</em></button>) : <div className="command-empty">No matching cases, evidence, devices, or findings.</div>}</div>}
          </div>
          <button className={`health-indicator health-${health.state}`} onClick={() => route.navigate("/status")} aria-label={`Platform health: ${health.state.replaceAll("-", " ")}`} title="View system status"><i/><span>{{ checking: "Checking systems", operational: "Core systems ready", "database-unavailable": "Database unavailable", "backend-unavailable": "Backend unavailable" }[health.state]}</span></button>
        </div>
      </header>
      <main className="content" onClick={() => searchOpen && setSearchOpen(false)}>{children}</main>
    </div>
    {mobile && <button className="mobile-backdrop" onClick={() => setMobile(false)} aria-label="Close navigation"/>}
  </div>;
}
