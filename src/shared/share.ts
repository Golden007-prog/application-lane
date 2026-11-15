// Sharing a report on GitHub: the report is cleaned on this computer first
// (src/server/clean-report.ts), saved as a file for the applicant to
// attach, and the repository's "Fill report" issue form opens filled in with
// a summary of it. The form labels the issue so the fixer can find it.

import type { IssueReport } from "./model";

export const REPORT_REPOSITORY = "Nikman800/application-lane";
export const REPORT_TEMPLATE = "fill-report.yml";
// The form's own label (.github/ISSUE_TEMPLATE/fill-report.yml).
export const REPORT_LABEL = "fill report";
// GitHub takes attachments of up to 25 MB.
export const ATTACHMENT_LIMIT = 25 * 1024 * 1024;
// A new-issue link longer than this is cut short by browsers or GitHub.
const LINK_LIMIT = 7_500;

// What the backend gives back for a report to share.
export type SharedReport = {
  report: IssueReport;
  replaced: Record<string, number>;
  removed: string[];
};

export const sharedFileName = (report: Pick<IssueReport, "id">) => `application-lane-report-${report.id}.json`;

const host = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

// One line per kind replaced, most first: "name (12)".
export const replacedSummary = (replaced: Record<string, number>) =>
  Object.entries(replaced)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, count]) => `${kind} (${count})`)
    .join(", ");

export function issueTitle({ report }: SharedReport) {
  const what = report.category.replaceAll("-", " ");
  const where = report.application?.company || host(report.tab.url);
  return `${what[0].toUpperCase()}${what.slice(1)} on ${where}${report.tab.ats ? ` (${report.tab.ats})` : ""}`.slice(0, 200);
}

// The issue's summary field, from the cleaned report only.
export function issueSummary({ report, replaced, removed }: SharedReport, note = report.note) {
  const lines = [
    `- Category: ${report.category}`,
    `- Site: ${host(report.tab.url)}${report.tab.ats ? ` (${report.tab.ats})` : ""}`,
    `- Page: ${report.tab.title}`,
    `- Application: ${report.application ? `${report.application.status}, ${report.application.workflowStage}` : "not tracked"}`,
    `- Extension: ${report.extension.version} (${report.extension.contentVersion})`,
    `- Report: ${report.id}, ${new Date(report.createdAt).toISOString().slice(0, 10)}`,
    `- Cleaned before sharing: ${replacedSummary(replaced) || "nothing to replace"}`,
    ...(removed.length ? [`- Left out: ${removed.join(", ")}`] : []),
  ];
  return [lines.join("\n"), note.trim() ? `\n${note.trim()}` : ""].join("\n").trim();
}

export function newIssueLink(shared: SharedReport, note = shared.report.note) {
  const link = (summary: string) => {
    const params = new URLSearchParams({
      template: REPORT_TEMPLATE,
      title: issueTitle(shared),
      summary,
    });
    return `https://github.com/${REPORT_REPOSITORY}/issues/new?${params}`;
  };
  const full = link(issueSummary(shared, note));
  if (full.length <= LINK_LIMIT) return full;
  // A long note is cut, not the facts above it; the attached file holds it
  // whole. Encoded, a character can take up to nine in the link.
  const room = Math.max(0, Math.floor((LINK_LIMIT - link(issueSummary(shared, "")).length) / 9) - 60);
  return link(issueSummary(shared, `${note.trim().slice(0, room).trimEnd()}…\n\n(The note continues in the attached report.)`));
}
