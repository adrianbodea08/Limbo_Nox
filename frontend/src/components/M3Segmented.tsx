// Material 3's segmented button.
//
// Four places in Nox were choosing between two or three mutually exclusive
// views — Timeline or List, Weeks or Months, All or Rocket or Sparta, Light or
// Dark or Midnight — and all four drew a row of separate outlined pills whose
// selected state was a background one shade off the container. On a card the
// difference was invisible: the settings page showed three identical pills and
// no way to tell which theme was on.
//
// A segmented button is the component that question has an answer for. One
// outlined container, segments divided by a hairline, and the selected one
// carries a filled background *and* a check — two signals, so it still reads
// when the fill is subtle and for anybody who cannot separate the two colours.
//
// Not tabs. Tabs change what a region contains and live at its top edge; a
// segmented button sets a value and can sit anywhere, which is why the theme
// picker is one of these and the project settings header is not.

interface Props<T extends string> {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  /** What the group is choosing, for anybody listening rather than looking. */
  label: string;
  /** Fill the width it is given rather than sizing to its labels. */
  stretch?: boolean;
}

export function M3Segmented<T extends string>({
  value, options, onChange, label, stretch = false,
}: Props<T>) {
  return (
    <div className={`m3seg${stretch ? " m3seg-stretch" : ""}`} role="group" aria-label={label}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            className={`m3seg-btn tk-layer${on ? " on" : ""}`}
            // Not aria-selected: that belongs to tabs and options. A segment is
            // a button that is currently pressed.
            aria-pressed={on}
            onClick={() => onChange(o.value)}
          >
            {on && (
              <svg className="m3seg-check" viewBox="0 -960 960 960" width="18" height="18"
                   fill="currentColor" aria-hidden="true">
                <path d="M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z" />
              </svg>
            )}
            <span>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export default M3Segmented;
