import React from "react";
import { createRoot } from "react-dom/client";
import { ClaudeProvider, useClaude } from "./core/provider";
import { ChatInterface } from "./components/ChatInterface";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { BridgeOffline, Pairing } from "./components/Pairing";
import "./styles/ui.css";

function App() {
  const { connection, items, busy, newChat, costUsd } = useClaude();

  return (
    <div className="app">
      <header className="header">
        <ConnectionStatus status={connection} />
        <div className="header-actions">
          {costUsd > 0 && <span className="cost">${costUsd.toFixed(2)}</span>}
          {connection === "connected" && items.length > 0 && (
            <button className="button ghost" onClick={newChat} disabled={busy}>
              New chat
            </button>
          )}
        </div>
      </header>
      {connection === "needs-token" ? (
        <Pairing />
      ) : connection === "connected" || items.length > 0 ? (
        <ChatInterface />
      ) : connection === "disconnected" ? (
        <BridgeOffline />
      ) : (
        <div className="setup">
          <p>Connecting to the bridge…</p>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("app")!).render(
  <ClaudeProvider>
    <App />
  </ClaudeProvider>,
);
