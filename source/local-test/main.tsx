import React from "react";
import { createRoot } from "react-dom/client";
import { LocalERP } from "./ui";
// Self-hosted variable fonts (SIL Open Font License): Inter for Latin text, Noto Sans Khmer for Khmer.
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/noto-sans-khmer/wght.css";
import "../app/globals.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/shell.css";
import "./styles/modules.css";
import "./styles/groups.css";
import "./styles/calendar.css";

createRoot(document.getElementById("root")!).render(<React.StrictMode><LocalERP /></React.StrictMode>);
