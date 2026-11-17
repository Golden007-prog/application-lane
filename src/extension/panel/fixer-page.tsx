// The panel's fixer page (panel.tsx, App): its markup, moved as it was.
import { fixerAgents, type FixerSettings, codexEfforts } from "../../shared/fixer-settings";
import { type FixerOverview } from "../../shared/model";
import { FixerProblems, agentNames, api, fixerLabels, modelSuggestions, type PanelState } from "../panel";

export function FixerPage({ panel }: { panel: PanelState }) {
  const { action, fixer, fixerSettings, setFixer, setFixerSettings } = panel;
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">REPORT FIXER</div>
          <h1>Fixer</h1>
        </div>
      </div>
      {!fixer ? (
        <div className="empty compact-empty">
          <h3>Fixer status unavailable</h3>
          <p>Connect to the local backend to see it.</p>
        </div>
      ) : (
        <>
          {(() => {
            // It beats every minute; three missed and it is not running.
            const running = Boolean(fixer.heartbeatAt && Date.now() - fixer.heartbeatAt < 3 * 60_000);
            return (
              <p className={`help fixer-running ${running ? "on" : "off"}`} role="status">
                {running
                  ? `Running${fixer.branch ? ` on ${fixer.branch}` : ""}.`
                  : `Not running${fixer.heartbeatAt ? ` since ${new Date(fixer.heartbeatAt).toLocaleString()}` : ""}. Start it with npm run fixer.`}
                {fixer.checkedThrough ? ` Fills saved up to ${new Date(fixer.checkedThrough).toLocaleString()} have been checked for problems.` : ""}
                {fixer.checkRetryAt ? ` The last check failed; it tries again at ${new Date(fixer.checkRetryAt).toLocaleTimeString()}.` : ""}
              </p>
            );
          })()}
          {fixerSettings && (
            <section className="card fixer-settings" aria-label="Fixer agents and models">
              <h2>Agents and models</h2>
              <p className="help">
                The fixer tries the agents you tick, in this order, and moves to the next only when one
                produces no fix. Changes apply from its next task.
                {fixer.inUse
                  ? ` In use now: ${fixer.inUse.agents.map((agent) => `${agentNames[agent]} (${agent === "claude" || agent === "claude2" ? fixer.inUse!.claudeModel : agent === "codex" ? fixer.inUse!.codexModel : fixer.inUse!.endpointModel || "endpoint's model"})`).join(", then ")}.`
                  : ""}
              </p>
              <ol className="agent-order">
                {[...fixerSettings.agents, ...fixerAgents.filter((agent) => !fixerSettings.agents.includes(agent))].map((agent) => {
                  const used = fixerSettings.agents.includes(agent);
                  const at = fixerSettings.agents.indexOf(agent);
                  return (
                    <li key={agent}>
                      <label>
                        <input
                          type="checkbox"
                          checked={used}
                          disabled={used && fixerSettings.agents.length === 1}
                          onChange={() =>
                            setFixerSettings({
                              ...fixerSettings,
                              agents: used ? fixerSettings.agents.filter((other) => other !== agent) : [...fixerSettings.agents, agent],
                            })
                          }
                        />
                        {agentNames[agent]}
                      </label>
                      {used && at > 0 && (
                        <button
                          className="text-button"
                          aria-label={`Try ${agentNames[agent]} earlier`}
                          onClick={() => {
                            const agents = [...fixerSettings.agents];
                            [agents[at - 1], agents[at]] = [agents[at], agents[at - 1]];
                            setFixerSettings({ ...fixerSettings, agents });
                          }}
                        >
                          Move up
                        </button>
                      )}
                      {fixer.health?.[agent] && (
                        <span className={`agent-health ${fixer.health[agent]!.ok ? "ok" : "broken"}`}>
                          {fixer.health[agent]!.ok ? "Works" : `Does not work: ${fixer.health[agent]!.detail}`}
                          {` (checked ${new Date(fixer.health[agent]!.checkedAt).toLocaleTimeString()}${fixer.health[agent]!.version ? `, ${fixer.health[agent]!.version}` : ""})`}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ol>
              {fixer.health && (
                <p className="help">
                  Before each task the fixer has every agent run one small command, and passes over one that
                  cannot. It asks a working agent again after an hour and a broken one after 15 minutes.{" "}
                  <button
                    className="text-button"
                    onClick={() =>
                      void action(async () => {
                        await api("/v1/fixer/health", "DELETE");
                        setFixer(await api<FixerOverview>("/v1/fixer"));
                      }, "The fixer will check every agent again before its next task.")
                    }
                  >
                    Check again
                  </button>
                </p>
              )}
              <div className="fixer-models">
                <label>
                  Claude model
                  <input list="claude-models" value={fixerSettings.claudeModel} onChange={(e) => setFixerSettings({ ...fixerSettings, claudeModel: e.target.value })} />
                </label>
                <label>
                  Codex model
                  <input list="codex-models" value={fixerSettings.codexModel} onChange={(e) => setFixerSettings({ ...fixerSettings, codexModel: e.target.value })} />
                </label>
                <label>
                  Codex second model (empty for none)
                  <input list="codex-models" value={fixerSettings.codexFallbackModel} onChange={(e) => setFixerSettings({ ...fixerSettings, codexFallbackModel: e.target.value })} />
                </label>
                <label>
                  Codex reasoning effort
                  <select value={fixerSettings.codexEffort} onChange={(e) => setFixerSettings({ ...fixerSettings, codexEffort: e.target.value as FixerSettings["codexEffort"] })}>
                    {codexEfforts.map((effort) => (
                      <option key={effort} value={effort}>{effort}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Endpoint model (empty for the backend's)
                  <input list="endpoint-models" value={fixerSettings.endpointModel} onChange={(e) => setFixerSettings({ ...fixerSettings, endpointModel: e.target.value })} />
                </label>
                <label>
                  Separate Claude login's settings folder
                  <input
                    placeholder="C:\Users\you\.claude-second"
                    value={fixerSettings.claude2ConfigDir}
                    onChange={(e) => setFixerSettings({ ...fixerSettings, claude2ConfigDir: e.target.value })}
                  />
                </label>
                <label>
                  Tasks at once
                  <select value={fixerSettings.parallel} onChange={(e) => setFixerSettings({ ...fixerSettings, parallel: Number(e.target.value) })}>
                    {[1, 2, 3].map((count) => (
                      <option key={count} value={count}>{count}</option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="help">
                Each task at once gets a checkout of its own, and their fixes are verified one at a time. The
                separate Claude login runs from its own settings folder: sign it in once from a terminal with
                CLAUDE_CONFIG_DIR set to that folder, then run claude and /login.
              </p>
              {(["claude", "codex", "endpoint"] as const).map((kind) => (
                <datalist key={kind} id={`${kind}-models`}>
                  {modelSuggestions[kind].map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
              ))}
              <button
                className="primary"
                onClick={() =>
                  void action(async () => {
                    const saved = await api<{ settings: FixerSettings }>("/v1/fixer/settings", "PUT", fixerSettings);
                    setFixerSettings(saved.settings);
                  }, "Fixer settings saved. They apply from its next task.")
                }
              >
                Save fixer settings
              </button>
            </section>
          )}
          {!fixer.items.length ? (
            <div className="empty compact-empty">
              <h3>Nothing for the fixer yet</h3>
              <p>Reports you file, and problems the checks find in your fills, appear here.</p>
            </div>
          ) : (
            <div className="issue-list">
              {fixer.items.map((item) => (
                <article className="issue-row" key={item.id}>
                  <div>
                    <span className="tag">{item.kind === "task" ? "found by the checks" : "your report"}</span>
                    <h3>{item.title}</h3>
                    <small>
                      {item.site ? `${item.site} · ` : ""}
                      {item.result?.status === "working" && item.result.startedAt
                        ? `working for ${Math.max(1, Math.round((Date.now() - item.result.startedAt) / 60_000))} min`
                        : item.result?.finishedAt
                          ? `finished ${new Date(item.result.finishedAt).toLocaleString()}`
                          : "queued"}
                    </small>
                    {item.problem && <p>{item.problem}</p>}
                    {item.result && item.result.status !== "queued" && (
                      <p className={`fixer-status ${item.result.status}`}>
                        <strong>{fixerLabels[item.result.status]}</strong>
                        {item.result.commit ? ` (${item.result.commit.slice(0, 7)})` : ""}
                        {item.result.summary ? `: ${item.result.summary}` : ""}
                        {item.result.liveCheck && <span className="live-check"> Check on the live site: {item.result.liveCheck}</span>}
                      </p>
                    )}
                    {item.result && <FixerProblems result={item.result} />}
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
