// Opening an issue over whatever you were doing.
//
// Every screen that lists issues wants the same two behaviours — click the row
// to glance at it, click the key to open it properly — and the glance should
// not cost you your place in a filtered table or a half-scrolled queue.
//
// The card needs the project metadata and the list of people to render, which
// is two requests no page should pay for until somebody actually opens
// something. So they are fetched on first open and kept for the rest of the
// visit.

import { useCallback, useState } from "react";
import { IssueCard } from "./IssueCard";
import { trackerApi } from "./model";
import type { TrackerIssue, TrackerMeta, TrackerUser } from "./model";

export function useIssueDialog(onChanged?: () => void) {
  const [issue, setIssue] = useState<TrackerIssue | null>(null);
  const [meta, setMeta] = useState<TrackerMeta | null>(null);
  const [users, setUsers] = useState<TrackerUser[]>([]);
  const [error, setError] = useState("");

  const open = useCallback(async (key: string) => {
    setError("");
    try {
      const [m, u, i] = await Promise.all([
        meta ?? trackerApi.meta(),
        users.length ? Promise.resolve(users) : trackerApi.users(),
        trackerApi.issue(key),
      ]);
      setMeta(m);
      setUsers(u);
      setIssue(i);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [meta, users]);

  const close = useCallback(() => setIssue(null), []);

  const dialog = issue && meta ? (
    <IssueCard
      key={issue.key}
      mode="edit"
      chrome="dialog"
      meta={meta}
      issue={issue}
      users={users}
      onClose={close}
      onSaved={(next) => {
        setIssue(next);
        onChanged?.();
      }}
      // The full page is a window of its own, same as the key — you asked for
      // it on purpose, so it should survive navigating away from here.
    />
  ) : null;

  return { open, close, dialog, error };
}
