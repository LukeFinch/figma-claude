import React from "react";
import type { ConnectionState } from "../core/types";

const LABELS: Record<ConnectionState, string> = {
  connecting: "Connecting",
  connected: "Connected",
  disconnected: "Bridge offline",
  "needs-token": "Not paired",
};

export const ConnectionStatus: React.FC<{ status: ConnectionState }> = ({ status }) => (
  <div className={`status status-${status}`} role="status">
    <span className="status-dot" aria-hidden />
    {LABELS[status]}
  </div>
);
