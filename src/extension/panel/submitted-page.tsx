// The panel's submitted page (panel.tsx, App): its markup, moved as it was.
import { ProgressBoard } from "../progress-board";
import { hostname, type PanelState } from "../panel";

export function SubmittedPage({ panel }: { panel: PanelState }) {
  const { progress, submissions } = panel;
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">HISTORY</div>
          <h1>Submitted applications</h1>
        </div>
      </div>
      <p className="help">
        Every application that went in, newest first: the ones the site
        confirmed, and the ones you marked submitted. It stays when an
        application is archived or removed from the list.
      </p>
      {submissions && <ProgressBoard progress={progress} submissions={submissions} />}
      {!submissions?.length ? (
        <div className="empty compact-empty">
          <h3>{submissions ? "Nothing submitted yet" : "History unavailable"}</h3>
          <p>{submissions ? "Applications appear here once they go in." : "Connect to the local backend to see it."}</p>
        </div>
      ) : (
        <div className="issue-list">
          {submissions.map((record) => (
            <article className="issue-row" key={record.applicationId}>
              <div>
                <span className="tag">{record.confirmedBySite ? "confirmed by the site" : "marked by you"}</span>
                <h3>{record.title}</h3>
                <small>
                  {record.company} · {new Date(record.submittedAt).toLocaleDateString()} ·{" "}
                  <a href={record.url} target="_blank" rel="noreferrer">{hostname(record.url)}</a>
                  {record.ats ? ` · ${record.ats}` : ""}
                </small>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
