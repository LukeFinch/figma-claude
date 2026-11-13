import React, { useState } from "react";
import { useClaude } from "../core/provider";

export const Pairing: React.FC = () => {
  const { pair } = useClaude();
  const [code, setCode] = useState("");

  return (
    <form
      className="setup"
      onSubmit={(e) => {
        e.preventDefault();
        if (code.trim()) pair(code);
      }}
    >
      <h2>Pair with the bridge</h2>
      <p>
        Enter the pairing code that <code>npm run bridge</code> printed in your terminal. You only need to do this once.
      </p>
      <label htmlFor="pair-code">Pairing code</label>
      <input
        id="pair-code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="ABCD-1234"
        autoComplete="off"
        spellCheck={false}
        autoFocus
      />
      <button type="submit" className="button primary" disabled={!code.trim()}>
        Pair
      </button>
    </form>
  );
};

export const BridgeOffline: React.FC = () => {
  const { reconnect } = useClaude();
  return (
    <div className="setup">
      <h2>Bridge not running</h2>
      <p>Start it from the project folder, and this panel will connect on its own:</p>
      <pre>npm run bridge</pre>
      <button className="button secondary" onClick={reconnect}>
        Retry now
      </button>
    </div>
  );
};
