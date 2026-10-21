import { LicenseManager } from "ag-grid-enterprise";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import "./index.css";

const licenseKey =
  (typeof process !== "undefined" && process.env?.AG_GRID_LICENSE_KEY) ||
  (typeof import.meta !== "undefined" &&
    (import.meta as { env?: Record<string, string> }).env?.VITE_AG_GRID_LICENSE_KEY);
if (licenseKey) {
  LicenseManager.setLicenseKey(licenseKey);
}

const rootElement = document.getElementById("root");

if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
