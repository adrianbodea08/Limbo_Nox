// The tracker's left navigation.
//
// One narrow rail of rooms — the product's destinations, always visible, never
// scrolling, one tap from anywhere. No second column: the projects hang off the
// Projects room as a dropdown, so somebody who is not looking for a project is
// not looking at a list of them either, and the board gets the width back.
//
// This replaced a 232px column holding five destinations, three headings, every
// project and the board's layout switch — one list mixing "where in the product
// am I" with "which board am I on". Those are different questions. The first is
// the rail, the second is this dropdown, and the third moved to the board's own
// bar, which is where a view control belongs.
//
// The rail is M3's navigation rail: icon over a short label, and the selected
// state is a full-round indicator behind the icon — the spec's own anatomy, not
// a background colour on the row.
//
// It fetches what it needs itself. One small request per page beats threading
// projects and teams through every screen that renders navigation.

import {
  Activity, FolderKanban, GitBranch, Rocket, Settings2, Users, Workflow, Zap,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { trackerApi } from "./model";
import type { TrackerProject, TrackerTeam } from "./model";

export interface RailProps {
  /** What is currently open: "my-work", "releases", "automations", "teams",
   *  "insights", "git", "projects", "project:CD". */
  active?: string;
  isAdmin?: boolean;
  /** Projects the caller already has, to save the request. */
  projects?: TrackerProject[];
  /** The board page keeps its own project switching so it can morph. */
  onProject?: (key: string) => void;
}

/** The rooms. Projects first because it is where the work is, then the order
 *  somebody moves through a week: what am I doing, what is the team carrying,
 *  what is going out, what runs itself, what git says, what it adds up to. */
const DESTINATIONS = [
  { id: "projects", Icon: FolderKanban, label: "Projects", to: "" },
  { id: "my-work", Icon: Workflow, label: "My work", to: "/my-work" },
  { id: "teams", Icon: Users, label: "Teams", to: "/teams", needsTeams: true },
  { id: "releases", Icon: Rocket, label: "Releases", to: "/?section=releases" },
  { id: "automations", Icon: Zap, label: "Automations", to: "/?section=automations" },
  { id: "git", Icon: GitBranch, label: "Git", to: "/?section=git" },
  { id: "insights", Icon: Activity, label: "Insights", to: "/?section=insights" },
] as const;

/** Tall enough to hold a realistic project list; used only to decide whether
 *  the menu has room to hang from the button or has to lift. */
const MENU_HEIGHT = 360;

export function TrackerRail({
  active = "", isAdmin = false, projects, onProject,
}: RailProps) {
  const nav = useNavigate();
  const [teams, setTeams] = useState<TrackerTeam[]>([]);
  const [own, setOwn] = useState<TrackerProject[]>([]);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    trackerApi.teams().then(setTeams).catch(() => {});
    if (!projects) trackerApi.meta().then((m) => setOwn(m.projects)).catch(() => {});
  }, [projects]);

  // Measured before paint so the menu never appears in the wrong place first,
  // and portalled so the rail's own overflow cannot clip it.
  useLayoutEffect(() => {
    if (!open) { setBox(null); return; }
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      setBox({
        left: r.right + 8,
        top: Math.max(8, Math.min(r.top, window.innerHeight - MENU_HEIGHT - 8)),
      });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const list = projects ?? own;
  const inProjects = active.startsWith("project:") || active === "projects";
  const current = active.startsWith("project:") ? active.slice("project:".length) : "";

  function go(key: string) {
    setOpen(false);
    if (onProject) onProject(key);
    else nav(`/?project=${key}`);
  }

  return (
    <nav className="tk-rail" aria-label="Sections">
      {DESTINATIONS.map((d) => {
        // One entry for teams, because it is one page: the teams are tabs
        // inside it. Two rail items for two teams made "compare them" a
        // navigation problem.
        if ("needsTeams" in d && d.needsTeams && teams.length === 0) return null;

        // A board, an issue and a project's settings are all *in* Projects. A
        // rail where nothing is lit on the page people spend the day on reads
        // as broken, and "which room am I in" has an answer here.
        const isProjects = d.id === "projects";
        const on = isProjects ? inProjects : active === d.id;

        return (
          <button
            key={d.id}
            ref={isProjects ? btnRef : undefined}
            type="button"
            className={`tk-nav-item${on ? " on" : ""}`}
            title={d.label}
            aria-current={on || undefined}
            aria-haspopup={isProjects || undefined}
            aria-expanded={isProjects ? open : undefined}
            onClick={() => (isProjects ? setOpen((o) => !o) : nav(d.to))}
          >
            <span className="tk-nav-pill tk-layer">
              <d.Icon size={20} strokeWidth={2} aria-hidden />
            </span>
            <span className="tk-nav-label">{d.label}</span>
          </button>
        );
      })}

      {open && box && createPortal(
        <>
          <div className="tkc-pop-back" onClick={() => setOpen(false)} />
          <div className="tk-projects" style={{ top: box.top, left: box.left }}
               role="menu" aria-label="Projects">
            <h2 className="tk-rail-title">Projects</h2>
            {list.map((p) => (
              <div key={p.id} className="tk-projects-row">
                <button
                  type="button"
                  role="menuitem"
                  className={`tk-rail-item tk-layer${p.key === current ? " tk-rail-on" : ""}`}
                  onClick={() => go(p.key)}
                >
                  <span className="tk-rail-key">{p.key}</span>
                  <span className="tk-rail-name">{p.name}</span>
                </button>
                {/* Settings are an admin's business, so the affordance only
                    exists for one. */}
                {isAdmin && (
                  <button
                    type="button"
                    className="tk-projects-cog tk-layer"
                    title={`${p.name} settings`}
                    aria-label={`${p.name} settings`}
                    onClick={() => { setOpen(false); nav(`/project/${p.key}/settings`); }}
                  >
                    <Settings2 size={15} aria-hidden />
                  </button>
                )}
              </div>
            ))}
            {!list.length && <p className="tk-dim tk-projects-none">No projects yet.</p>}
          </div>
        </>,
        document.body,
      )}
    </nav>
  );
}
