// The tracker's left navigation, on every page that belongs to it.
//
// Two columns, not one. It used to be a single 232px rail holding five
// destinations, three section headings, every project and the board's layout
// switch — and by the time a workspace had six projects the thing you were
// looking for was below the fold in a list that mixed "where in the product am
// I" with "which board am I on". Those are different questions and they now
// have different columns:
//
//   * a narrow **rail** of destinations — the product's rooms, always visible,
//     never scrolling, one tap from anywhere
//   * a **sidebar** of what is inside the room you are in
//
// The second half of that was a lie in the first version: the sidebar showed the
// project list in every room, including Releases, Git and Insights, none of
// which are about one project. So a person on the Insights page was looking at a
// list of projects that did nothing. The sidebar now belongs to Projects, and
// every other room gets the width back for its own content.
//
// Borrowed from Plane, which is right about this, along with its icon set — the
// unicode glyphs this used to draw (◉ ▲ ◇ ⚡ ⑂) are text characters, so they
// rendered at whatever weight and baseline the font felt like and never quite
// looked drawn on purpose. Kept from us: the midnight palette and the M3
// indicator — the selected destination is a pill behind the icon, which is what
// the spec's navigation rail actually says, not a background colour change on
// the row.
//
// It fetches what it needs itself. One small request per page beats threading
// projects and teams through every screen that happens to render a sidebar.

import {
  Activity, FolderKanban, GitBranch, MoreVertical, Rocket, Users, Workflow, Zap,
} from "lucide-react";
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

/** The rooms. Boards first because it is what the sidebar is showing — the
 *  rail item names the list beneath it, the way Plane's "Projects" does. Then
 *  the order somebody moves through a week: what am I doing, what is the team
 *  carrying, what is going out, what runs itself, what git says about it all. */
const DESTINATIONS = [
  { id: "projects", Icon: FolderKanban, label: "Projects", to: "/" },
  { id: "my-work", Icon: Workflow, label: "My work", to: "/my-work" },
  { id: "teams", Icon: Users, label: "Teams", to: "/teams", needsTeams: true },
  { id: "releases", Icon: Rocket, label: "Releases", to: "/?section=releases" },
  { id: "automations", Icon: Zap, label: "Automations", to: "/?section=automations" },
  { id: "git", Icon: GitBranch, label: "Git", to: "/?section=git" },
  { id: "insights", Icon: Activity, label: "Insights", to: "/?section=insights" },
] as const;

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
  // The sidebar is the Projects room's own content. Anywhere else there is
  // nothing for it to hold, and an empty 212px column is worse than no column.
  const inProjects = active.startsWith("project:") || active === "projects";

  return (
    <div className={`tk-nav${inProjects ? "" : " tk-nav-bare"}`}>
      <nav className="tk-rail" aria-label="Sections">
        {DESTINATIONS.map((d) => {
          // One entry for teams, because it is one page: the teams are tabs
          // inside it. Two rail items for two teams made "compare them" a
          // navigation problem.
          if ("needsTeams" in d && d.needsTeams && teams.length === 0) return null;
          // A board, an issue and a project's settings are all *in* Projects.
          // A rail where nothing is lit on the page people spend the day on
          // reads as broken, and "which room am I in" has an answer here.
          const on = d.id === "projects" ? inProjects : active === d.id;
          return (
            <button
              key={d.id}
              type="button"
              className={`tk-nav-item${on ? " on" : ""}`}
              title={d.label}
              aria-current={on || undefined}
              onClick={() => nav(d.to)}
            >
              <span className="tk-nav-pill tk-layer">
                <d.Icon size={20} strokeWidth={2} aria-hidden />
              </span>
              <span className="tk-nav-label">{d.label}</span>
            </button>
          );
        })}
      </nav>

      {inProjects && (
      <aside className="tk-side" aria-label="Projects">
        <h2 className="tk-rail-title">Projects</h2>
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
                ><MoreVertical size={16} aria-hidden /></button>
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
      </aside>
      )}
    </div>
  );
}
