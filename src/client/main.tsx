import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { AuthProvider } from "./auth";
import { configureMonacoRuntime } from "./monacoRuntime";
import { registerOfflineAppShell } from "./offline";
import { ThemeProvider } from "./theme";
import "./styles.css";

configureMonacoRuntime();
registerOfflineAppShell();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>,
);
