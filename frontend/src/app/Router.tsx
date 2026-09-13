import { AppShell, useLocationPath } from "../layouts/RefinedAppShell";
import { ConnectedOverviewPage } from "../pages/ConnectedOverviewPage";
import { ConnectedCasesPage } from "../pages/ConnectedCasesPage";
import { ConnectedLiveOperationsPage } from "../pages/ConnectedLiveOperationsPage";
import { ImportEvidencePage } from "../pages/ImportEvidencePage";
import { SystemStatusPage } from "../pages/SystemStatusPage";
import { ConnectedCaseWorkspaceV3Page } from "../pages/ConnectedCaseWorkspaceV3Page";
import { ConnectedAssistantPage } from "../pages/ConnectedAssistantPage";
import { SystemHealthProvider } from "../health/SystemHealthContext";

export function Router() {
  const route=useLocationPath(); let page;
  if(route.path==="/") page=<ConnectedOverviewPage navigate={route.navigate}/>;
  else if(route.path==="/assistant") page=<ConnectedAssistantPage search={route.search}/>;
  else if(route.path==="/cases") page=<ConnectedCasesPage navigate={route.navigate}/>;
  else if(/^\/cases\/\d+(?:\/|$)/.test(route.path)) page=<ConnectedCaseWorkspaceV3Page path={route.path} search={route.search} navigate={route.navigate}/>;
  else if(route.path.startsWith("/cases/")) page=<div className="state-box" role="alert"><strong>Legacy demonstration case unavailable</strong><p>Production routes only display persisted numeric case IDs. Select a connected case from the register.</p><button onClick={()=>route.navigate("/cases")}>Open cases</button></div>;
  else if(route.path==="/live") page=<ConnectedLiveOperationsPage navigate={route.navigate} search={route.search}/>;
  else if(route.path==="/import") page=<ImportEvidencePage search={route.search} navigate={route.navigate}/>;
  else if(route.path==="/status") page=<SystemStatusPage/>;
  else page=<div className="not-found"><span>404</span><h1>Investigation view not found</h1><button onClick={()=>route.navigate("/")}>Return to overview</button></div>;
  return <SystemHealthProvider><AppShell route={route}>{page}</AppShell></SystemHealthProvider>;
}
