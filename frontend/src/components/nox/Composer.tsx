// The editor, loaded when somebody actually opens something to write in.
//
// Tiptap and ProseMirror are about half a megabyte before compression. The
// board, My work, Insights, Releases and the whole rail never write a word, and
// making them download an editor to render a list of cards is a cost paid by
// everybody for a thing used by somebody. So the editor sits behind a lazy
// import and arrives with the first dialog that needs it.
//
// The fallback is a box the size of the editor rather than a spinner: the
// dialog's layout should not jump when the chunk lands.

import { Suspense, lazy } from "react";
import type { RichTextProps } from "./RichText";

const Editor = lazy(() => import("./RichText"));

export function Composer(props: RichTextProps) {
  return (
    <Suspense
      fallback={
        <div className={`tk-rt${props.compact ? " tk-rt-compact" : ""}`} aria-busy="true">
          <div className="tk-rt-bar" />
          <div className="tk-rt-body" />
        </div>
      }
    >
      <Editor {...props} />
    </Suspense>
  );
}

export default Composer;
