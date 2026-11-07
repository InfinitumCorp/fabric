import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { createEngine } from "./session.ts";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing_root");

createRoot(root).render(
  <StrictMode>
    <App engine={createEngine()} secure={window.isSecureContext === true} />
  </StrictMode>,
);
