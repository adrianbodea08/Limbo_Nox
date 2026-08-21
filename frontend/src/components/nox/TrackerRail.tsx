// The tracker's left rail, on every page that belongs to it.
//
// Lifted out of the board page once My work needed it too. A person should not
// have to go back to a board to reach their own queue, and a page without the
// rail reads as somewhere you have left the tracker rather than somewhere
// inside it.
//
// It fetches what it needs itself. One small request per page beats threading
// projects and teams through every screen that happens to render a sidebar.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { trackerApi } from "./model";
import type { TrackerProject, TrackerTeam } from "./model";

export interface RailProps {
  /** What is currently open: "my-work", "releases", "automations",
   *  "team:ROCKET", "project:CD". */
  active?: string;
  isAdmin?: boolean;
  /** Projects the caller already has, to save the request. */
  projects?: TrackerProject[];
  /** The board page keeps its own project switching so it can morph. */
  onProject?: (key: string) => void;
  /** Extra items under the projects — the board's layout switch. */
  children?: React.ReactNode;
}

export function TrackerRail({
  active = "", isAdmin = false, projects, onProject, children,
}: RailProps) {
  const nav = useNavigate();
  const [teams, setTeams] = useState<TrackerTeam[]>([]);
  const [own, setOwn] = useState<TrackerProject[]>([]);
  const [menu, setMenu] = useState<number | null>(null);

  useEffect(() => {
    trackerApi.teams().then(setTeams).catch(() => {});
    if (!projects) trackerApi.meta().then((m) => setOwn(m.projects)).catch(() => {});
  }, [projects]);

  const list = projects ?? own;

  return (
    <nav className="tk-rail">
      <button
        type="button"
        className={`tk-rail-item tk-layer tk-rail-wide${active === "my-work" ? " tk-rail-on" : ""}`}
        onClick={() => nav("/my-work")}
      >
        <span className="tk-rail-glyph">◉</span>
        <span className="tk-rail-name">My work</span>
      </button>
      {/* One entry, because it is one page: the teams are tabs inside it. Two
          rail items for two teams made "compare them" a navigation problem. */}
      {teams.length > 0 && (
        <button
          type="button"
          className={`tk-rail-item tk-layer tk-rail-wide${active === "teams" ? " tk-rail-on" : ""}`}
          onClick={() => nav("/teams")}
        >
          <span className="tk-rail-glyph">▲</span>
          <span className="tk-rail-name">Team Management</span>
        </button>
      )}

      <h2 className="tk-rail-title tk-rail-title-2">Plan</h2>
      <button
        type="button"
        className={`tk-rail-item tk-layer tk-rail-wide${active === "releases" ? " tk-rail-on" : ""}`}
        onClick={() => nav("/?section=releases")}
      >
        <span className="tk-rail-glyph">◇</span>
        <span className="tk-rail-name">Releases</span>
      </button>
      <button
        type="button"
        className={`tk-rail-item tk-layer tk-rail-wide${active === "automations" ? " tk-rail-on" : ""}`}
        onClick={() => nav("/?section=automations")}
      >
        <span className="tk-rail-glyph">⚡</span>
        <span className="tk-rail-name">Automations</span>
      </button>

      <button
        type="button"
        className={`tk-rail-item tk-layer tk-rail-wide${active === "git" ? " tk-rail-on" : ""}`}
        onClick={() => nav("/?section=git")}
      >
        <span className="tk-rail-glyph">⑂</span>
        <span className="tk-rail-name">Git</span>
      </button>

      <h2 className="tk-rail-title tk-rail-title-2">Projects</h2>
      {list.map((p) => (
        <div key={p.id} className="tk-rail-line">
          <button
            type="button"
            className={`tk-rail-item tk-layer${active === `project:${p.key}` ? " tk-rail-on" : ""}`}
            onClick={() => (onProject ? onProject(p.key) : nav(`/?project=${p.key}`))}
          >
            <span className="tk-rail-key">{p.key}</span>
            <span className="tk-rail-name">{p.name}</span>
          </button>
          {/* Settings are an admin's business, so the affordance only exists
              for one. */}
          {isAdmin && (
            <div className="tk-rail-more-wrap">
              <button
                type="button"
                className="tk-rail-more tk-layer"
                title={`${p.name} settings`}
                aria-label={`${p.name} settings`}
                onClick={(e) => { e.stopPropagation(); setMenu(menu === p.id ? null : p.id); }}
              >
                ⋮
              </button>
              {menu === p.id && (
                <>
                  <div className="tkc-pop-back" onClick={() => setMenu(null)} />
                  <div className="tk-rail-menu">
                    <button type="button" className="tkc-kebab-row tk-layer"
                            onClick={() => { nav(`/project/${p.key}/settings`); setMenu(null); }}>
                      Project settings
                    </button>
                    <button type="button" className="tkc-kebab-row tk-layer"
                            onClick={() => {
                              navigator.clipboard?.writeText(
                                `${location.origin}/tracker?project=${p.key}`);
                              setMenu(null);
                            }}>
                      Copy board link
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      ))}

      {children}
    </nav>
  );
}
