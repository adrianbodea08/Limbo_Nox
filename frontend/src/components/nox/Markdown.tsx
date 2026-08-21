// Markdown, rendered.
//
// The toolbar over the description has been writing `**bold**` since the day it
// was built, and nothing in this product has ever shown it as bold. Every issue
// description and every comment was read as raw syntax — asterisks, hyphens and
// backticks — which is worse than having had no toolbar at all, because it made
// people *add* the noise.
//
// **Rendered to React elements, never to an HTML string.** There is no
// `dangerouslySetInnerHTML` here and no sanitiser to keep correct: an issue
// description is text other people wrote, and the safest way to render text
// other people wrote is to never let it become markup in the first place. The
// only place a value from the text reaches an attribute is a link's `href`, and
// `safeHref` decides that one by scheme.
//
// Small on purpose. It covers what the toolbar writes, what people paste out of
// other trackers, and the two things this product knows about that Markdown does
// not: issue keys and @names.

import type { ReactNode } from "react";
import { Fragment } from "react";
import { IssueKey } from "./IssueKey";
import type { TrackerUser } from "./model";

// ------------------------------------------------------------------ inline --

/** One pass, in priority order. Code first so nothing inside it is parsed. */
const INLINE = new RegExp([
  /(?<code>`[^`\n]+`)/,
  /(?<bold>\*\*[^\n]+?\*\*)/,
  /(?<strike>~~[^\n]+?~~)/,
  /(?<em>\*[^*\n]+?\*|(?<![\w])_[^_\n]+?_(?![\w]))/,
  /(?<link>\[[^\]\n]*\]\([^)\s]+\))/,
  // Parens are allowed inside: a Wikipedia address ends in one, and stopping
  // at the first `(` cuts the link in half. What the URL must not keep is the
  // sentence's own punctuation, which `trimTail` takes off afterwards.
  /(?<bare>https?:\/\/[^\s<>[\]]+)/,
  /(?<key>\b[A-Z][A-Z0-9]{1,9}-\d+\b)/,
  // The `u` here is for the type checker only — `.source` drops flags, and the
  // combined expression below sets them.
  /(?<at>@[\p{L}\p{N}'.-]+(?:[ ][\p{L}\p{N}'.-]+)?)/u,
].map((r) => r.source).join("|"), "gu");

/** Only schemes that cannot execute. A `javascript:` href in a description is
 *  the one way text somebody else typed could still run, so it is refused here
 *  rather than anywhere later. */
function safeHref(url: string): string | null {
  const trimmed = url.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  if (/^[/#]/.test(trimmed)) return trimmed;
  return null;
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  const safe = safeHref(href);
  // A refused link stays as its own text — visibly a URL, inertly so.
  if (!safe) return <>{children}</>;
  return (
    <a className="tk-md-a" href={safe} target="_blank" rel="noopener noreferrer"
       onClick={(e) => e.stopPropagation()}>
      {children}
    </a>
  );
}

/** The person this `@fragment` means, or nobody.
 *
 *  The same rule the server uses in `notify.find_mentions`: longest match
 *  first, an ambiguous first name reaches nobody. That is the point — what
 *  renders as a chip is exactly what notifies, so a mention that will not
 *  reach anybody *looks* like it will not reach anybody. */
function whoIs(fragment: string, people: TrackerUser[]): TrackerUser | null {
  const text = fragment.slice(1).toLowerCase();
  const whole = people.find((p) => (p.display_name || "").toLowerCase() === text);
  if (whole) return whole;
  const head = text.split(" ")[0];
  const byFirst = people.filter((p) =>
    (p.display_name || "").toLowerCase().split(" ")[0] === head);
  return byFirst.length === 1 ? byFirst[0] : null;
}

/** Split a bare URL from the punctuation that ends the sentence it sits in.
 *
 *  "see https://example.com/x." is a URL and a full stop, not an address with a
 *  dot on the end. A closing paren is the awkward one: it belongs to the URL
 *  when the URL opened it, and to the sentence when it did not. */
function trimTail(url: string): [string, string] {
  let head = url;
  let tail = "";
  for (;;) {
    const end = head.slice(-1);
    if (!end) break;
    const opens = (head.match(/\(/g) ?? []).length;
    const closes = (head.match(/\)/g) ?? []).length;
    if (".,;:!?'\"".includes(end) || (end === ")" && closes > opens)) {
      tail = end + tail;
      head = head.slice(0, -1);
      continue;
    }
    break;
  }
  return [head, tail];
}

function inline(text: string, people: TrackerUser[], keyed = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  // `matchAll` before rendering, not `exec` while rendering. INLINE is a
  // module-level /g/ regex and this function recurses into itself for bold and
  // italic — an inner call would reset `lastIndex` under the outer loop, which
  // re-matches the same position forever. `matchAll` iterates a clone, so the
  // recursion below cannot reach the iteration above.
  for (const m of [...text.matchAll(INLINE)]) {
    if ((m.index ?? 0) > last) out.push(text.slice(last, m.index));
    const g = m.groups ?? {};
    const id = `${keyed}${n++}`;
    const body = m[0];

    if (g.code) {
      out.push(<code key={id} className="tk-md-code">{body.slice(1, -1)}</code>);
    } else if (g.bold) {
      out.push(<strong key={id}>{inline(body.slice(2, -2), people, id)}</strong>);
    } else if (g.strike) {
      out.push(<s key={id}>{inline(body.slice(2, -2), people, id)}</s>);
    } else if (g.em) {
      out.push(<em key={id}>{inline(body.slice(1, -1), people, id)}</em>);
    } else if (g.link) {
      const cut = body.indexOf("](");
      const label = body.slice(1, cut);
      out.push(
        <Link key={id} href={body.slice(cut + 2, -1)}>
          {label ? inline(label, people, id) : body.slice(cut + 2, -1)}
        </Link>,
      );
    } else if (g.bare) {
      const [url, trail] = trimTail(body);
      out.push(<Link key={id} href={url}>{url}</Link>);
      if (trail) out.push(trail);
    } else if (g.key) {
      out.push(<IssueKey key={id} issueKey={body} />);
    } else if (g.at) {
      // Two words first, then one — "@Ana Mihalache stopped" must not swallow
      // "stopped" when it already matched a person on the full name.
      const two = whoIs(body, people);
      const one = two ? null : whoIs(body.split(" ")[0], people);
      const who = two ?? one;
      if (who) {
        const used = two ? body : body.split(" ")[0];
        out.push(
          <span key={id} className="tk-md-at" title={who.display_name}>@{who.display_name}</span>,
        );
        // Whatever the regex took beyond the name goes back on the queue.
        if (used.length < body.length) out.push(body.slice(used.length));
      } else {
        // Reaches nobody, so it does not get to look like it does.
        out.push(body);
      }
    }
    last = (m.index ?? 0) + body.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ------------------------------------------------------------------- blocks --

const HEADING = /^(#{1,4})\s+(.*)$/;
const BULLET = /^[-*+]\s+(.*)$/;
const NUMBER = /^\d+[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const RULE = /^(-{3,}|\*{3,}|_{3,})$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
const FENCE = /^```(\w*)\s*$/;

/** Markdown as React elements. `people` decides which `@names` become chips. */
export function Markdown({ text, people = [] }: { text: string; people?: TrackerUser[] }) {
  const lines = (text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let n = 0;
  const key = () => `b${n++}`;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      i++; // the closing fence, or the end of the text if it was never closed
      blocks.push(
        <pre key={key()} className="tk-md-pre">
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (RULE.test(line.trim())) { blocks.push(<hr key={key()} className="tk-md-hr" />); i++; continue; }

    const head = HEADING.exec(line);
    if (head) {
      // Two visual levels, not four. This is a description inside a dialog with
      // the issue's own summary right above it, and nobody writing a ticket has
      // ever needed a fourth-level heading — but plenty type `###` for their
      // only one, so `###` has to look like a heading rather than a footnote.
      const Tag = head[1].length <= 2 ? "h3" : "h4";
      const id = key();
      blocks.push(<Tag key={id} className="tk-md-h">{inline(head[2], people, id)}</Tag>);
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        body.push((QUOTE.exec(lines[i]) as RegExpExecArray)[1]);
        i++;
      }
      blocks.push(
        <blockquote key={key()} className="tk-md-quote">
          <Markdown text={body.join("\n")} people={people} />
        </blockquote>,
      );
      continue;
    }

    if (BULLET.test(line)) {
      const items: string[] = [];
      while (i < lines.length && BULLET.test(lines[i])) {
        items.push((BULLET.exec(lines[i]) as RegExpExecArray)[1]);
        i++;
      }
      // A list of `[ ]` items is a checklist, and reads as one. Not clickable:
      // ticking a box in a description is an edit, and an edit that happens
      // without the Save button is a different feature with its own decisions.
      const tasks = items.every((t) => TASK.test(t));
      const id = key();
      blocks.push(
        <ul key={id} className={`tk-md-ul${tasks ? " tk-md-tasks" : ""}`}>
          {items.map((t, k) => {
            const task = TASK.exec(t);
            return (
              <li key={k} className={task && task[1] !== " " ? "tk-md-done" : undefined}>
                {task && <span className="tk-md-box" aria-hidden>{task[1] === " " ? "☐" : "☑"}</span>}
                {/* One element, not loose text and inline tags. A checklist row
                    is a flex box so the tick hangs beside the text, and every
                    stray text node inside a flex container becomes its own
                    flex item — which lays a sentence out in columns instead of
                    wrapping it. */}
                {task
                  ? <span className="tk-md-task">{inline(task[2], people, `${id}l${k}`)}</span>
                  : inline(t, people, `${id}l${k}`)}
              </li>
            );
          })}
        </ul>,
      );
      continue;
    }

    if (NUMBER.test(line)) {
      const items: string[] = [];
      while (i < lines.length && NUMBER.test(lines[i])) {
        items.push((NUMBER.exec(lines[i]) as RegExpExecArray)[1]);
        i++;
      }
      const id = key();
      blocks.push(
        <ol key={id} className="tk-md-ol">
          {items.map((t, k) => <li key={k}>{inline(t, people, `${id}o${k}`)}</li>)}
        </ol>,
      );
      continue;
    }

    // A paragraph runs until a blank line or the start of another block. The
    // first line is taken unconditionally: every branch of this loop has to
    // advance `i`, and a paragraph that collected nothing would not.
    const para: string[] = [lines[i++]];
    while (i < lines.length && lines[i].trim()
           && !HEADING.test(lines[i]) && !BULLET.test(lines[i]) && !NUMBER.test(lines[i])
           && !QUOTE.test(lines[i]) && !FENCE.test(lines[i]) && !RULE.test(lines[i].trim())) {
      para.push(lines[i]);
      i++;
    }
    const id = key();
    blocks.push(
      <p key={id} className="tk-md-p">
        {para.map((l, k) => (
          // A newline inside a paragraph is a line break. Strict Markdown
          // wants two trailing spaces for that; nobody types two trailing
          // spaces, and every tracker people came from broke the line.
          <Fragment key={k}>
            {k > 0 && <br />}
            {inline(l, people, `${id}p${k}`)}
          </Fragment>
        ))}
      </p>,
    );
  }

  return <div className="tk-md">{blocks}</div>;
}

/** The same text with the markup taken off, for a card preview or a tooltip —
 *  somewhere there is one line and no room to render anything. */
export function plain(text: string): string {
  return (text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    // After the bullet, the tick. On one line a checklist is a gist, and
    // "[x] [ ] [ ]" is three characters of nothing three times over.
    .replace(/^\s*\[[ xX]\]\s+/gm, "")
    .replace(/^\s{0,3}\d+[.)]\s+/gm, "")
    .replace(/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/gm, " ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

export default Markdown;
