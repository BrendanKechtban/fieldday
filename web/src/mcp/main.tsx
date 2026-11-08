import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { McpApp } from "./McpApp";

createRoot(document.getElementById("root")!).render(<StrictMode><McpApp /></StrictMode>);
