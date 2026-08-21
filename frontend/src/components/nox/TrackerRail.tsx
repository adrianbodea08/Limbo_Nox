// The tracker's left navigation.
//
// One column of rooms — the product's destinations — with the projects
// expanding underneath the Projects room rather than floating beside it. A
// dropdown was the wrong shape for this: the project you are in is part of
// where you are, and a menu that closes hides that the moment you look away.
// A disclosure keeps it on screen.
//
// This is M3's navigation *drawer* rather than its rail: at rail width the
// labels had to sit under the icons and "Automations" barely fit across
// seventy-six pixels. A drawer item is the same anatomy laid out sideways —
// icon, label, and a full-round indicator behind the whole row for the
// selected one.
//
// The board's layout switch is not here. It decides how the thing beside the
// filters is drawn, so it lives on the board's own bar.
//
// It fetches what it needs itself. One small request per page beats threading
// projects and teams through every screen that renders navigation.

import {
  Activity, ChevronRight, FolderKanban, GitBranch, Rocket, Settings2, Users,
  Workflow, Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
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
  { id: "my-work", Icon: Workflow, label: "My work", to: "/my-work" },
  { id: "teams", Icon: Users, label: "Teams", to: "/teams", needsTeams: true },
  { id: "releases", Icon: Rocket, label: "Releases", to: "/?section=releases" },
  { id: "automations", Icon: Zap, label: "Automations", to: "/?section=automations" },
  { id: "git", Icon: GitBranch, label: "Git", to: "/?section=git" },
  { id: "insights", Icon: Activity, label: "Insights", to: "/?section=insights" },
] as const;

const REMEMBER = "nox-projects-open";

export function TrackerRail({
  active = "", isAdmin = false, projects, onProject,
}: RailProps) {
  const nav = useNavigate();
  const [teams, setTeams] = useState<TrackerTeam[]>([]);
  const [own, setOwn] = useState<TrackerProject[]>([]);

  const inProjects = active.startsWith("project:") || active === "projects";
  // Open until somebody says otherwise, and then closed until they say
  // otherwise again — including while a project is open. Forcing it open
  // "because you are inside one" was the first version, and it made the
  // control refuse to do the one thing it says it does, which is worse than
  // the confusion it was guarding against. The page's own title says which
  // project this is.
  const [expanded, setExpanded] = useState(() => {
    const saved = localStorage.getItem(REMEMBER);
    return saved === null ? true : saved === "1";
  });

  useEffect(() => {
    trackerApi.teams().then(setTeams).catch(() => {});
    if (!projects) trackerApi.meta().then((m) => setOwn(m.projects)).catch(() => {});
  }, [projects]);

  const list = projects ?? own;
  const current = active.startsWith("project:") ? active.slice("project:".length) : "";

  function toggle() {
    const next = !expanded;
    setExpanded(next);
    localStorage.setItem(REMEMBER, next ? "1" : "0");
  }

  return (
    <nav className="tk-rail" aria-label="Sections">
      {/* Projects: a room and a disclosure. The row navigates, the chevron
          opens — two jobs that would fight if one control did both, because
          "show me the list" and "take me to the board" are different wants. */}
      <div className="tk-rail-group">
        <button
          type="button"
          className={`tk-nav-item${inProjects ? " on" : ""}`}
          aria-current={inProjects || undefined}
          onClick={() => nav("/")}
        >
          <FolderKanban size={20} strokeWidth={2} aria-hidden />
          <span className="tk-nav-label">Projects</span>
        </button>
        <button
          type="button"
          className="tk-rail-twist tk-layer"
          aria-expanded={expanded}
          aria-label={expanded ? "Hide the projects" : "Show the projects"}
          title={expanded ? "Hide the projects" : "Show the projects"}
          onClick={toggle}
        >
          <ChevronRight size={16} className={expanded ? "tk-twisted" : undefined} aria-hidden />
        </button>
      </div>

      {expanded && (
        <div className="tk-rail-sub">
          {list.map((p) => (
            <div key={p.id} className="tk-rail-line">
              <button
                type="button"
                className={`tk-rail-item tk-layer${p.key === current ? " tk-rail-on" : ""}`}
                // The name is truncated at this width; the full one is a hover
                // away rather than gone.
                title={p.name}
                onClick={() => (onProject ? onProject(p.key) : nav(`/?project=${p.key}`))}
              >
                <span className="tk-rail-key">{p.key}</span>
                <span className="tk-rail-name">{p.name}</span>
              </button>
              {/* Settings are an admin's business, so the affordance only
                  exists for one. */}
              {isAdmin && (
                <button
                  type="button"
                  className="tk-rail-cog tk-layer"
                  title={`${p.name} settings`}
                  aria-label={`${p.name} settings`}
                  onClick={() => nav(`/project/${p.key}/settings`)}
                >
                  <Settings2 size={15} aria-hidden />
                </button>
              )}
            </div>
          ))}
          {!list.length && <p className="tk-dim tk-rail-none">No projects yet.</p>}
        </div>
      )}

      {DESTINATIONS.map((d) => {
        // One entry for teams, because it is one page: the teams are tabs
        // inside it. Two rail items for two teams made "compare them" a
        // navigation problem.
        if ("needsTeams" in d && d.needsTeams && teams.length === 0) return null;
        const on = active === d.id;
        return (
          <button
            key={d.id}
            type="button"
            className={`tk-nav-item${on ? " on" : ""}`}
            aria-current={on || undefined}
            onClick={() => nav(d.to)}
          >
            <d.Icon size={20} strokeWidth={2} aria-hidden />
            <span className="tk-nav-label">{d.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
