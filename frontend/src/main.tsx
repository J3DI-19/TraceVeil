import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./refinements.css";
import "./live-monitor-refinements.css";
import "./case-workspace-refinements.css";
import "./case-accessibility-refinements.css";
import "./settings-refinements.css";
import "./shell-core.css";
import "./assistant-central-refinements.css";
import "./sidebar.css";
import "./typography-refinements.css";
import "./assistant-chat-refinements.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
