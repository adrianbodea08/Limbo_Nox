// The editor.
//
// What you type is what it looks like. `1. ` becomes a numbered list, `---`
// becomes a divider, `# ` a heading, `->` an arrow, `**bold**` bold — and the
// toolbar acts on the same document rather than on syntax. Paste a page of
// Markdown from somewhere else and it arrives formatted, by the same route.
//
// **What is stored is still Markdown.** That is not a detail: the descriptions
// already in the database are Markdown, full-text search reads them as text,
// board cards strip them with `plain()`, and `Markdown.tsx` renders them
// read-only in comments and asks. An editor with its own JSON document format
// would have orphaned all four. `@tiptap/markdown` parses on the way in and
// serialises on the way out, so the file on disk never changes shape.
//
// Built on Tiptap — see docs/EDITOR.md section 7 for the comparison that chose
// it. It is headless, which is the part that matters here: it owns the document
// and the selection, and this file owns every pixel, so the M3 audit still has
// to pass.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import Typography from "@tiptap/extension-typography";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import Suggestion from "@tiptap/suggestion";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import {
  Bold, Code, Heading1, Heading2, Italic, Link2, List, ListOrdered,
  ListTodo, Minus, Quote, Redo2, SquareCode, Strikethrough, Undo2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Face } from "./Face";
import type { TrackerUser } from "./model";

// ------------------------------------------------------------- mentions --

/** Whole name first, then any word of it, then anywhere — the same ranking the
 *  old textarea used, and for the same reason: somebody typing "mi" means
 *  Mihalache far more often than they mean Du-mi-tru. */
function rank(people: TrackerUser[], query: string): TrackerUser[] {
  const q = query.trim().toLowerCase();
  const out: { who: TrackerUser; r: number }[] = [];
  for (const who of people) {
    if (who.active === false) continue;
    const name = (who.display_name || "").toLowerCase();
    if (!q) { out.push({ who, r: 0 }); continue; }
    if (name.startsWith(q)) out.push({ who, r: 0 });
    else if (name.split(" ").some((w) => w.startsWith(q))) out.push({ who, r: 1 });
    else if (name.includes(q)) out.push({ who, r: 2 });
  }
  out.sort((a, b) => a.r - b.r || a.who.display_name.localeCompare(b.who.display_name));
  return out.slice(0, 6).map((o) => o.who);
}

interface Popup {
  items: TrackerUser[];
  at: { left: number; top: number; bottom: number };
  pick: number;
  choose: (who: TrackerUser) => void;
}

/** A mention is inserted as **plain `@Name` text**, not as a node of its own.
 *
 *  A node would have to carry an id and serialise back to `@Name` through a
 *  custom markdown spec, and the only thing that buys is a chip while you are
 *  still typing. What the server matches is the text, and text is what this
 *  writes — so a name that completed here is a name that notifies, with nothing
 *  in between that could disagree. */
function mentionSuggestion(
  peopleRef: React.MutableRefObject<TrackerUser[]>,
  show: (p: Popup | null) => void,
  pickRef: React.MutableRefObject<number>,
) {
  return Extension.create({
    name: "noxMention",
    addProseMirrorPlugins() {
      let items: TrackerUser[] = [];
      let range = { from: 0, to: 0 };
      // Where the caret was when the list last moved. The arrow keys repaint
      // the list without the caret having moved, so they reuse this rather
      // than asking for a rectangle that has not changed.
      let where = { left: 0, top: 0, bottom: 0 };
      const editor = this.editor;

      const choose = (who: TrackerUser) => {
        editor.chain().focus()
          .insertContentAt(range, `@${who.display_name} `)
          .run();
        show(null);
      };

      const paint = (props: { clientRect?: (() => DOMRect | null) | null }) => {
        const box = props.clientRect?.();
        if (!box || !items.length) { show(null); return; }
        where = { left: box.left, top: box.top, bottom: box.bottom };
        show({ items, at: where, pick: pickRef.current, choose });
      };

      return [
        Suggestion({
          editor,
          char: "@",
          // Off on purpose. Names are two words, but you type a prefix and press
          // Tab — and a suggestion that survives a space stays open through
          // half a sentence.
          allowSpaces: false,
          items: ({ query }) => rank(peopleRef.current, query),
          render: () => ({
            onStart: (props) => {
              items = props.items as TrackerUser[];
              range = props.range;
              pickRef.current = 0;
              paint(props);
            },
            onUpdate: (props) => {
              items = props.items as TrackerUser[];
              range = props.range;
              pickRef.current = 0;
              paint(props);
            },
            onKeyDown: ({ event }) => {
              if (!items.length) return false;
              // Tab and Enter both insert. Tab because that is what the user
              // asked for and what every other completion does; Enter because
              // a list that is open under the caret has claimed the key.
              if (event.key === "Tab" || event.key === "Enter") {
                choose(items[pickRef.current]);
                return true;
              }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                const step = event.key === "ArrowDown" ? 1 : items.length - 1;
                pickRef.current = (pickRef.current + step) % items.length;
                show({ items, at: where, pick: pickRef.current, choose });
                return true;
              }
              if (event.key === "Escape") { show(null); return true; }
              return false;
            },
            onExit: () => show(null),
          }),
        }),
      ];
    },
  });
}

// ----------------------------------------------------------- serialising --

const ENTITY = /&(amp|lt|gt|quot|#39);/g;
const CHAR: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'",
};

/** Markdown is not HTML.
 *
 *  `@tiptap/markdown` HTML-escapes `&`, `<` and `>` on the way out, so a
 *  description reading `queued -> running` came back as `queued -&gt; running`
 *  and `a & b` as `a &amp; b`. Two things break:
 *
 *  1. Opening an issue and saving it rewrites prose nobody touched.
 *  2. `Markdown.tsx` renders to React elements and never interprets entities,
 *     so the read-only view shows the five characters `&amp;` while the editor
 *     shows `&`. The two views disagree, which is the one thing this feature
 *     exists to prevent.
 *
 *  The document itself is clean — parsing `&amp;` and parsing `&` both give a
 *  text node holding `&` — so this is purely the serializer, and undoing it is
 *  the faithful rendering of what is actually in the document.
 *
 *  Code is left exactly as it is: the serializer does not escape inside a fence
 *  or a code span, so an HTML sample that genuinely contains `&amp;` must keep
 *  it. */
function unescapeProse(md: string): string {
  return md
    // Odd indices are the code regions, which are handed back untouched.
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) => (i % 2 ? part : part.replace(ENTITY, (_, e: string) => CHAR[e])))
    .join("");
}

// ---------------------------------------------------------------- paste --

/** Does this look like somebody meant it as Markdown?
 *
 *  Parsing every paste as Markdown turns "5 * 3 * 2 = 30" into italics, and
 *  refusing to parse any of it means pasting a spec from a wiki arrives as one
 *  grey wall. So: parse it when it carries a construct that only Markdown has,
 *  and paste it as text when it does not. Shift+Ctrl+V always pastes as text,
 *  which is the escape hatch for the times this guesses wrong. */
const LOOKS_LIKE_MARKDOWN = new RegExp([
  /^\s{0,3}#{1,6}\s/, // heading
  /^\s{0,3}[-*+]\s/, // bullet
  /^\s{0,3}\d+[.)]\s/, // number
  /^\s{0,3}>\s/, // quote
  /^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/, // rule
  /^\s*```/, // fence
  /^\s{0,3}\|.*\|/, // table
].map((r) => r.source).join("|"), "m");

const INLINE_MARKDOWN = /\*\*[^\s*][^*]*\*\*|~~[^~]+~~|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)/;

const plainPasteKey = new PluginKey("noxPlainPaste");

function markdownPaste() {
  return Extension.create({
    name: "noxMarkdownPaste",
    addProseMirrorPlugins() {
      const editor = this.editor;
      // Set by the keymap below for one paste only, then cleared.
      let plainOnce = false;

      return [
        new Plugin({
          key: plainPasteKey,
          props: {
            handleKeyDown(_view, event) {
              if ((event.ctrlKey || event.metaKey) && event.shiftKey
                  && event.key.toLowerCase() === "v") {
                plainOnce = true;
              }
              return false;
            },
            handlePaste(view, event) {
              const text = event.clipboardData?.getData("text/plain");
              if (!text) return false;
              if (plainOnce) { plainOnce = false; return false; }
              // Real HTML on the clipboard means the source app already said
              // what it meant. Tiptap handles that better than re-reading its
              // plain-text shadow as Markdown.
              if (event.clipboardData?.getData("text/html")) return false;
              if (!LOOKS_LIKE_MARKDOWN.test(text) && !INLINE_MARKDOWN.test(text)) return false;

              event.preventDefault();
              editor.chain().focus()
                .insertContent(text, { contentType: "markdown" })
                .run();
              void view;
              return true;
            },
          },
        }),
      ];
    },
  });
}

// --------------------------------------------------------------- toolbar --

interface Tool {
  key: string;
  title: string;
  Icon: typeof Bold;
  run: (e: Editor) => void;
  on?: (e: Editor) => boolean;
  /** A rule before it in the toolbar. */
  gap?: boolean;
}

const TOOLS: Tool[] = [
  { key: "h1", title: "Heading", Icon: Heading1,
    run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run(),
    on: (e) => e.isActive("heading", { level: 1 }) },
  { key: "h2", title: "Subheading", Icon: Heading2,
    run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
    on: (e) => e.isActive("heading", { level: 2 }) },
  { key: "bold", title: "Bold  ⌘B", Icon: Bold, gap: true,
    run: (e) => e.chain().focus().toggleBold().run(),
    on: (e) => e.isActive("bold") },
  { key: "italic", title: "Italic  ⌘I", Icon: Italic,
    run: (e) => e.chain().focus().toggleItalic().run(),
    on: (e) => e.isActive("italic") },
  { key: "strike", title: "Strikethrough", Icon: Strikethrough,
    run: (e) => e.chain().focus().toggleStrike().run(),
    on: (e) => e.isActive("strike") },
  { key: "code", title: "Code", Icon: Code,
    run: (e) => e.chain().focus().toggleCode().run(),
    on: (e) => e.isActive("code") },
  { key: "bullet", title: "Bullet list", Icon: List, gap: true,
    run: (e) => e.chain().focus().toggleBulletList().run(),
    on: (e) => e.isActive("bulletList") },
  { key: "number", title: "Numbered list", Icon: ListOrdered,
    run: (e) => e.chain().focus().toggleOrderedList().run(),
    on: (e) => e.isActive("orderedList") },
  { key: "task", title: "Checklist", Icon: ListTodo,
    run: (e) => e.chain().focus().toggleTaskList().run(),
    on: (e) => e.isActive("taskList") },
  { key: "link", title: "Link", Icon: Link2, gap: true,
    run: (e) => {
      const was = e.getAttributes("link").href ?? "";
      const url = window.prompt("Address", was);
      if (url === null) return;
      if (!url) { e.chain().focus().unsetLink().run(); return; }
      e.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    },
    on: (e) => e.isActive("link") },
  { key: "quote", title: "Quote", Icon: Quote,
    run: (e) => e.chain().focus().toggleBlockquote().run(),
    on: (e) => e.isActive("blockquote") },
  { key: "block", title: "Code block", Icon: SquareCode,
    run: (e) => e.chain().focus().toggleCodeBlock().run(),
    on: (e) => e.isActive("codeBlock") },
  { key: "rule", title: "Divider", Icon: Minus,
    run: (e) => e.chain().focus().setHorizontalRule().run() },
  { key: "undo", title: "Undo  ⌘Z", Icon: Undo2, gap: true,
    run: (e) => e.chain().focus().undo().run() },
  { key: "redo", title: "Redo  ⇧⌘Z", Icon: Redo2,
    run: (e) => e.chain().focus().redo().run() },
];

// ----------------------------------------------------------------- editor --

export interface RichTextProps {
  /** Markdown in, Markdown out. */
  value: string;
  onChange: (markdown: string) => void;
  people?: TrackerUser[];
  placeholder?: string;
  autoFocus?: boolean;
  /** A comment box rather than a description: shorter, fewer tools. */
  compact?: boolean;
}

export function RichText({
  value, onChange, people = [], placeholder, autoFocus, compact,
}: RichTextProps) {
  const [popup, setPopup] = useState<Popup | null>(null);
  const peopleRef = useRef(people);
  peopleRef.current = people;
  const pickRef = useRef(0);
  // What we last told the parent, so an echo of our own value does not reset
  // the document and throw the caret to the top.
  const ours = useRef(value);

  const extensions = useMemo(() => [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      // Opened in a new window, and never on a click inside the editor —
      // clicking a link while writing means "put the caret there".
      link: { openOnClick: false, autolink: true },
      codeBlock: { languageClassPrefix: "lang-" },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Markdown,
    // `->` becomes →, `--` an em-dash, `...` an ellipsis, and 20 more.
    Typography,
    Placeholder.configure({ placeholder: placeholder ?? "" }),
    markdownPaste(),
    mentionSuggestion(peopleRef, setPopup, pickRef),
  ], [placeholder]);

  const editor = useEditor({
    extensions,
    content: value,
    contentType: "markdown",
    autofocus: autoFocus ? "end" : false,
    editorProps: {
      attributes: {
        class: "tk-rt-body tk-md",
        // The dialog listens for Escape to close. Inside the editor it means
        // "dismiss whatever is open here", so the editor stops it going up.
        spellcheck: "true",
      },
    },
    onUpdate: ({ editor: e }) => {
      const md = unescapeProse(e.getMarkdown());
      ours.current = md;
      onChange(md);
    },
  }, [extensions]);

  // The parent can change the value under us — switching issue, a refresh
  // after saving. Only reset when it is genuinely somebody else's text.
  useEffect(() => {
    if (!editor) return;
    if (value === ours.current) return;
    ours.current = value;
    editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
  }, [value, editor]);

  const close = useCallback(() => setPopup(null), []);
  useEffect(() => {
    if (!popup) return;
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, [popup, close]);

  if (!editor) return null;

  const tools = compact
    ? TOOLS.filter((t) => !["h1", "h2", "block", "rule", "undo", "redo"].includes(t.key))
    : TOOLS;

  return (
    <div className={`tk-rt${compact ? " tk-rt-compact" : ""}`}>
      <div className="tk-rt-bar" role="toolbar" aria-label="Formatting">
        {tools.map((t) => (
          <span key={t.key} className="tk-rt-slot">
            {t.gap && <span className="tkc-tb-div" />}
            <button
              type="button"
              className={`tkc-tb tk-layer${t.on?.(editor) ? " on" : ""}`}
              title={t.title}
              aria-label={t.title}
              aria-pressed={t.on ? t.on(editor) : undefined}
              // mousedown, not click: the editor must not lose the selection
              // the button is about to act on.
              onMouseDown={(e) => { e.preventDefault(); t.run(editor); }}
            >
              <t.Icon size={17} aria-hidden />
            </button>
          </span>
        ))}
      </div>

      <EditorContent editor={editor} className="tk-rt-shell" />

      {popup && createPortal(
        <ul className="tk-mention" role="listbox"
            style={{
              left: Math.min(popup.at.left, window.innerWidth - 250),
              top: popup.at.bottom + 6,
            }}>
          {popup.items.map((who, i) => (
            <li key={who.id} role="option" aria-selected={i === popup.pick}>
              <button type="button"
                      className={`tk-mention-opt tk-layer${i === popup.pick ? " on" : ""}`}
                      onMouseDown={(e) => { e.preventDefault(); popup.choose(who); }}>
                <Face size={22} name={who.display_name} avatar={who.avatar} />
                <span className="tk-mention-name">{who.display_name}</span>
                {who.craft && <span className="tk-dim tk-mention-craft">{who.craft}</span>}
              </button>
            </li>
          ))}
          <li className="tk-mention-hint tk-dim">Tab to insert</li>
        </ul>,
        document.body,
      )}
    </div>
  );
}

export default RichText;
