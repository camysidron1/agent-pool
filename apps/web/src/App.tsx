import { useMemo, useState, type ChangeEvent, type FormEvent } from "react";

import { createPublicApiClient } from "./api";
import {
  clearStoredOperatorId,
  normalizeOperatorId,
  readStoredOperatorId,
  saveStoredOperatorId,
  type BrowserStorage,
} from "./auth";

export type AppProps = {
  readonly apiBaseUrl?: string;
  readonly storage?: BrowserStorage | null;
};

export function App({ apiBaseUrl, storage = readBrowserStorage() }: AppProps) {
  const initialOperatorId = readStoredOperatorId(storage) ?? "";
  const [operatorId, setOperatorId] = useState(initialOperatorId);
  const [operatorDraft, setOperatorDraft] = useState(initialOperatorId);
  const [authError, setAuthError] = useState<string | null>(null);
  const isAuthenticated = operatorId.length > 0;
  const api = useMemo(
    () => (isAuthenticated ? createPublicApiClient({ baseUrl: apiBaseUrl, operatorId }) : null),
    [apiBaseUrl, isAuthenticated, operatorId],
  );

  function submitOperator(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const normalized = normalizeOperatorId(operatorDraft);

    if (!normalized) {
      setAuthError("Operator id is required.");
      return;
    }

    saveStoredOperatorId(storage, normalized);
    setOperatorId(normalized);
    setOperatorDraft(normalized);
    setAuthError(null);
  }

  function signOut(): void {
    clearStoredOperatorId(storage);
    setOperatorId("");
    setOperatorDraft("");
    setAuthError(null);
  }

  function updateOperatorDraft(event: ChangeEvent<HTMLInputElement>): void {
    setOperatorDraft(event.currentTarget.value);
  }

  if (!isAuthenticated) {
    return (
      <main className="app-shell auth-shell" aria-labelledby="auth-title">
        <section className="auth-panel">
          <p className="eyebrow">Agent Pool</p>
          <h1 id="auth-title">Operator sign in</h1>
          <form className="auth-form" onSubmit={submitOperator}>
            <label htmlFor="operator-id">Operator id</label>
            <div className="auth-row">
              <input
                id="operator-id"
                name="operator-id"
                autoComplete="username"
                value={operatorDraft}
                onChange={updateOperatorDraft}
              />
              <button type="submit">Continue</button>
            </div>
            {authError ? <p className="form-error">{authError}</p> : null}
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell" data-api-ready={api ? "true" : "false"}>
      <header className="topbar">
        <div>
          <p className="eyebrow">Agent Pool</p>
          <h1>Project board</h1>
        </div>
        <div className="operator-menu">
          <span>{operatorId}</span>
          <button type="button" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      <section className="workspace-band" aria-label="Project board">
        <div className="empty-board">
          <h2>Select a project</h2>
          <p>The authenticated board will load project tasks from the public API.</p>
        </div>
      </section>
    </main>
  );
}

function readBrowserStorage(): BrowserStorage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}
