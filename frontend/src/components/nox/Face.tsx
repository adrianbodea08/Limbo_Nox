// A person, wherever one is named.
//
// Separate from components/Face.tsx on purpose: that one resolves a Jira
// accountId through a fetched map, because the stats tables are built from
// snapshots that do not carry a picture. The tracker's rows already carry the
// avatar, so there is nothing to look up and nothing to wait for.
//
// Falls back to initials in a tonal circle, so a row is never ragged when
// somebody has no picture.

export function initials(name: string): string {
  const parts = (name || "").replace(/[._]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Face({
  name, avatar, size = 24, title,
}: {
  name?: string | null;
  avatar?: string | null;
  size?: number;
  title?: string;
}) {
  // Nobody assigned is a state worth drawing rather than a gap — an empty cell
  // reads as "not loaded yet".
  if (!name) {
    return (
      <span className="tk-face tk-face-none" style={{ width: size, height: size }}
            title={title ?? "Unassigned"} aria-hidden="true">
        ·
      </span>
    );
  }
  // No loading="lazy": these are data URIs, so there is no request to defer,
  // and a lazy image that never enters the viewport never decodes at all.
  return avatar ? (
    <img className="tk-face" src={avatar} alt=""
         title={title ?? name} style={{ width: size, height: size }} />
  ) : (
    <span className="tk-face" title={title ?? name}
          style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}>
      {initials(name)}
    </span>
  );
}

/** Avatar and name together — how a person is written in a row or a list. */
export function Person({
  name, avatar, size = 22, suffix,
}: {
  name?: string | null;
  avatar?: string | null;
  size?: number;
  suffix?: React.ReactNode;
}) {
  return (
    <span className="tk-assignee">
      <Face name={name} avatar={avatar} size={size} />
      <span className="tk-person-name">{name ?? "Unassigned"}</span>
      {suffix}
    </span>
  );
}
