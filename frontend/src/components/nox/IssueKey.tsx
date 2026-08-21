// The issue key, everywhere it appears.
//
// Two targets on one card, and the difference is deliberate: clicking the card
// opens the issue over what you were doing, clicking the **key** opens it in
// its own window. One is "let me glance at this and carry on", the other is
// "I am going to work on this", and they want different things — the first
// should be easy to dismiss, the second should survive navigating away.
//
// It is a real anchor, so the browser's own habits work: middle-click,
// ctrl-click, right-click to copy the address, and the URL in the status bar
// on hover. A div with an onClick has none of that.

export function IssueKey({
  issueKey, className = "tk-key", title,
}: {
  issueKey: string;
  className?: string;
  title?: string;
}) {
  return (
    <a
      className={`${className} tk-issue-key`}
      href={`/issue/${issueKey}`}
      target="_blank"
      rel="noopener"
      title={title ?? `Open ${issueKey} in a new window`}
      // The card underneath opens a dialog; the key is not asking for that.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {issueKey}
    </a>
  );
}
