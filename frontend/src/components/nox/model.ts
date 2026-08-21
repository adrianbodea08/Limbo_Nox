// The tracker's own types and its slice of the API.
//
// Kept beside the page rather than in the shared api.ts because the tracker
// talks to a different database with a different lifecycle: every one of these
// calls can legitimately answer "there is no database yet", and the rest of the
// app should not have to know that.

import { request } from "../../api";

export interface TrackerProject {
  id: number;
  key: string;
  name: string;
  description: string;
  position: number;
  issue_seq: number;
}

export interface TrackerType {
  id: number;
  key: string;
  name: string;
  icon: string;
  colour: string;
  hierarchy_level: number;
}

export interface TrackerStatus {
  id: number;
  key: string;
  name: string;
  /** todo | in_progress | done — the column that makes cross-project reporting work. */
  category: string;
  colour: string;
}

export interface TrackerField {
  id: number;
  key: string;
  name: string;
  description: string;
  kind: string;
  options: unknown[];
}

export interface TrackerView {
  id: number;
  project_id: number | null;
  name: string;
  shared: boolean;
  filter: FilterNode | null;
  group_by: string;
  renderer: string;
  columns: string[];
  sort: SortSpec[];
  position: number;
}

export interface TrackerMeta {
  projects: TrackerProject[];
  issueTypes: TrackerType[];
  statuses: TrackerStatus[];
  fields: TrackerField[];
  views: TrackerView[];
}

/** A field this project asks for on this issue's type, and the value it holds.
 *  Which fields exist is decided in project settings, never on an issue. */
export interface IssueField {
  id: number | null;
  key: string;
  name: string;
  kind: string;
  options: unknown[];
  description: string;
  required: boolean;
  position: number;
  value: unknown;
  /** Still carries a value but is no longer asked for on this type. */
  unconfigured?: boolean;
}

/** A relationship an issue can have, and how it reads in each direction. */
export interface LinkType {
  kind: string;
  outward: string;
  inward: string;
  symmetric?: boolean;
}

/** The compact shape of an issue when it appears inside another one. */
export interface RelatedIssue {
  id: number;
  key: string;
  summary: string;
  priority: string;
  status_name: string;
  status_colour: string;
  status_category: string;
  type_name: string;
  type_icon: string;
  type_colour: string;
  hierarchy_level: number;
  project_key: string;
}

export type ParentCandidate = RelatedIssue;

export interface IssueLink {
  id: number;
  kind: string;
  /** How it reads from this issue: "blocks", "is blocked by". */
  phrase: string;
  direction: "outward" | "inward";
  issue: RelatedIssue;
}

export interface TrackerIssue {
  id: number;
  key: string;
  project_id: number;
  project_key: string;
  issue_type_id: number;
  type_key: string;
  type_name: string;
  type_icon: string;
  type_colour: string;
  status_id: number;
  status_key: string;
  status_name: string;
  status_category: string;
  status_colour: string;
  summary: string;
  description: string;
  assignee_id: number | null;
  assignee_name: string | null;
  assignee_avatar: string | null;
  /** Who verifies it. On every issue type, like the assignee. */
  tester_id: number | null;
  tester_name: string | null;
  tester_avatar: string | null;
  reporter_id: number | null;
  priority: string;
  parent_id: number | null;
  /** Enough of the parent to name it on a card, without opening the issue. */
  parent_key: string | null;
  parent_summary: string | null;
  /** Counts a card shows without being opened. `blocked_by` excludes blockers
   *  that are already finished — those are history, not an obstacle. */
  blocked_by?: number;
  /** Present on board and table rows; the full list is on the issue itself. */
  git_summary?: GitSummary | null;
  link_count?: number;
  child_count?: number;
  comment_count?: number;
  custom: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  comments?: TrackerComment[];
  activity?: TrackerEvent[];
  releases?: IssueRelease[];
  fields?: IssueField[];
  links?: IssueLink[];
  children?: RelatedIssue[];
  parent?: RelatedIssue | null;
  /** Unfinished work standing in front of this one. */
  blockers?: { id: number; key: string; summary: string; status_name: string }[];
  /** Branches and pull requests — the full list on one issue, the summary on a
   *  board card. */
  git?: GitRef[];
}

/** A branch, commit, pull request or build, and what git says about it. */
export interface GitRef {
  id: number;
  kind: "branch" | "pr" | "commit" | "build";
  repo: string;
  ref: string;
  title: string;
  url: string;
  /** Reads differently per kind, because the kinds are different things:
   *  pr — open | draft | merged | closed
   *  branch — identical | ahead | behind | diverged, against the default branch
   *  build — running | success | failure | cancelled | skipped
   *  commit — empty. A commit has no state beyond having happened. */
  state: string;
  /** passing | failing | pending | none. Separate from state on purpose — a
   *  merged PR whose build failed is a thing that happens. */
  checks: string;
  author: string;
  branch: string;
  opened_at: string | null;
  merged_at: string | null;
  /** Where the issue key was found: title, branch or body. */
  found_in?: string;
}

/** The compact form on a board card: how many PRs, the liveliest state, and
 *  whether anything is failing. */
export interface GitSummary {
  prs: number;
  state: string;
  checks: string;
}

/** A GitHub organisation that has authorised the app. */
export interface GitInstallation {
  installation_id: number;
  account_login: string;
  account_type: string;
  /** "all" or "selected" — the second quietly leaves new repos out. */
  repo_selection: string;
  suspended: boolean;
  connected_at: string;
  last_sync_at: string | null;
  last_sync: string;
}

export interface GitStatus {
  /** Whether an app is registered at all. Not configured is a state. */
  configured: boolean;
  webhookSecretSet: boolean;
  installations: GitInstallation[];
  installUrl: string | null;
  message?: string;
}

export interface TrackerUser {
  id: number;
  display_name: string;
  avatar: string;
  /** What they do — "dev", "ai", "qa", "ops". It lives on their team
   *  membership, so somebody on no team has none. */
  craft: string | null;
  team_id: number | null;
  active: boolean;
}

export interface IssueRelease {
  id: number;
  name: string;
  state: string;
  kind: string;
  shipped_at: string | null;
}

export interface TrackerComment {
  id: number;
  body: string;
  author_id: number | null;
  author_name?: string | null;
  author_avatar?: string | null;
  created_at: string;
}

export interface TrackerEvent {
  batchId: number;
  at: string;
  actorId: number | null;
  actorKind: string;
  actorName: string | null;
  actorAvatar: string | null;
  kind: string;
  changes: { field: string; from: string | null; to: string | null }[];
  payload?: Record<string, unknown>;
}

export interface TrackerTransition {
  id: number;
  name: string;
  to_status_id: number;
  to_name: string;
  to_colour: string;
  to_category: string;
}

export interface BoardColumn {
  key: number | string | null;
  name: string;
  category?: string;
  colour?: string;
  /** A column holds one *or more* statuses; reordering inside it needs to know
   *  which, because the band being reordered is the whole visible column. */
  statuses?: { id: number; name: string; colour: string; category: string }[];
  issues: TrackerIssue[];
}

export interface BoardData {
  groupBy: string;
  total: number;
  columns: BoardColumn[];
}

export type FilterOp =
  | "eq" | "ne" | "in" | "not_in" | ">" | ">=" | "<" | "<="
  | "contains" | "is_empty" | "is_not_empty";

export interface Condition {
  field: string;
  op?: FilterOp;
  value?: unknown;
}

export type FilterNode = Condition | { all: FilterNode[] } | { any: FilterNode[] };

export interface SortSpec {
  field: string;
  dir?: "asc" | "desc";
}

/** Whether the tracker has a database behind it at all. */
export interface TrackerStatusInfo {
  configured: boolean;
  connected: boolean;
  error?: string | null;
}

// ----------------------------------------------------------------- releases --

export interface TrackerComponent {
  id: number;
  key: string;
  name: string;
  repo: string;
}

export interface ReleaseCounts {
  todo: number;
  in_progress: number;
  done: number;
  total: number;
}

export interface ReleaseSummary {
  id: number;
  name: string;
  kind: string;
  state: string;
  cycle_start: string | null;
  planned_at: string | null;
  shipped_at: string | null;
  description: string;
  notes: string;
  notes_published: boolean;
  issue_count: number;
  counts: ReleaseCounts;
}

/** A release as the timeline needs it: its window, what it ships, and whether
 *  it has slipped. `late` is computed by the server on every read — a stored
 *  flag is wrong the moment somebody moves the date. */
export interface TimelineRelease {
  id: number;
  name: string;
  kind: string;
  state: string;
  cycle_start: string | null;
  planned_at: string | null;
  shipped_at: string | null;
  late: boolean;
  issue_count: number;
  counts: ReleaseCounts;
  artifacts: ReleaseArtifact[];
}

export interface TimelineData {
  releases: TimelineRelease[];
  /** Releases with no date at all — drafts, deliberately not drawn. */
  undated: number;
  /** The server's today, so the marker does not drift with the client clock. */
  today: string;
}

export interface ReleaseArtifact {
  id: number;
  release_id: number;
  component_id: number;
  component_key: string;
  component_name: string;
  component_repo: string;
  version: string;
  state: string;
  planned_at: string | null;
  shipped_at: string | null;
}

export interface ReleaseAction {
  id: number;
  release_id: number;
  title: string;
  description: string;
  owner_id: number | null;
  owner_name: string | null;
  position: number;
  done_at: string | null;
}

export interface ReleaseIssueRow {
  id: number;
  key: string;
  summary: string;
  priority: string;
  status_name: string;
  status_colour: string;
  status_category: string;
  type_name: string;
  type_icon: string;
  type_colour: string;
  project_key: string;
  assignee_name: string | null;
}

/** A candidate for a release: an issue that is on no release yet. */
export interface UnreleasedIssue {
  id: number;
  key: string;
  summary: string;
  priority: string;
  status_name: string;
  status_colour: string;
  status_category: string;
  type_name: string;
  type_icon: string;
  type_colour: string;
  project_key: string;
  assignee_name: string | null;
  assignee_avatar: string | null;
}

export interface ReleaseDetail extends ReleaseSummary {
  artifacts: ReleaseArtifact[];
  issues: ReleaseIssueRow[];
  actions: ReleaseAction[];
  byProject: { project: string; total: number; done: number }[];
  activity?: TrackerEvent[];
}

// --------------------------------------------------------------- automations --

export interface AutomationRule {
  id: number;
  name: string;
  description: string;
  enabled: boolean;
  project_id: number | null;
  trigger: Record<string, any>;
  conditions: Record<string, unknown>;
  actions: Record<string, any>[];
  run_as: string;
  failure_count: number;
  disabled_reason: string;
}

export interface AutomationRun {
  id: number;
  rule_id: number;
  outcome: string;
  condition_result: boolean;
  steps: Record<string, any>[];
  error: string;
  dry_run: boolean;
  at: string;
}

export interface AutomationBlocks {
  triggers: { type: string; label: string; entity: string }[];
  actions: {
    type: string;
    label: string;
    fields: { key: string; kind: string; required?: boolean; options?: string[] }[];
  }[];
  variables: string[];
  maxDepth: number;
  failureLimit: number;
}

export interface FieldDefinition {
  id: number;
  key: string;
  name: string;
  description: string;
  kind: string;
  options: unknown[];
  reason: string;
  archived_at: string | null;
  /** Where this field is asked for. */
  usage: {
    project_id: number;
    project_key: string;
    type_id: number;
    type_name: string;
    required: boolean;
  }[];
  /** How many live issues actually carry a value — the honest use signal. */
  filled: number;
}

export interface ProjectSettingsData {
  project: TrackerProject & { visibility: string };
  access: { id: number; kind: string; value: string }[];
  workflow: {
    workflow_id: number;
    /** Where each box sits on the diagram, by status id. */
    layout: Record<string, { x: number; y: number }>;
    /** The board's columns. A column holds one status or several; a status in
     *  no column is hidden, and its issues are not on the board. */
    board: {
      columns: {
        id: number;
        name: string;
        position: number;
        issue_count: number;
        statuses: { id: number; name: string; colour: string; category: string; issue_count: number }[];
      }[];
      hidden: { id: number; name: string; colour: string; category: string; issue_count: number }[];
    };
    columns: (TrackerStatus & { position: number; issue_count: number })[];
    transitions: {
      id: number;
      from_status_id: number | null;
      to_status_id: number;
      name: string;
      conditions: Record<string, unknown> | null;
    }[];
  };
  types: (TrackerType & {
    position: number;
    fields: { id: number; key: string; name: string; kind: string; required: boolean }[];
  })[];
  allStatuses: TrackerStatus[];
  allTypes: TrackerType[];
  allFields: TrackerField[];
}

// ---------------------------------------------------------------- the work --

export interface TrackerTeam {
  id: number;
  key: string;
  name: string;
  colour: string;
  lead_id: number | null;
  lead_name?: string | null;
  members: { user_id: number; craft: string; display_name: string; avatar: string }[];
}

/** An issue as a queue card: enough to decide, not enough to read. */
export interface QueueIssue {
  id: number;
  key: string;
  summary: string;
  priority: string;
  plan_priority: string;
  rank: string;
  team_id: number | null;
  assignee_id: number | null;
  assignee_name: string | null;
  assignee_avatar: string | null;
  status_id: number;
  status_name: string;
  status_colour: string;
  status_category: string;
  type_name: string;
  type_key: string;
  type_icon: string;
  type_colour: string;
  project_key: string;
  team_name: string | null;
  updated_at: string;
  urgent_at: string | null;
  urgent_reason: string;
  urgent_by_name: string | null;
  /** The sentence saying why this card is where it is. */
  why: string;
  paused: { paused_at: string; for_key: string | null; reason: string } | null;
}

export interface MyWorkData {
  who: string | null;
  avatar: string | null;
  urgent: QueueIssue[];
  inProgress: QueueIssue[];
  next: QueueIssue[];
  paused: QueueIssue[];
  /** Finished in the last fortnight — recent and capped on the server. */
  done: QueueIssue[];
  team: TrackerTeam | null;
  leads: TrackerTeam | null;
}

export interface TeamQueueData {
  /** Null on the All tab, where the scope is every team rather than one. */
  team: TrackerTeam | null;
  /** Everything open for this team, as one list — the backlog. */
  issues: QueueIssue[];
  members: {
    user_id: number; craft: string; display_name: string; avatar: string;
    team_id?: number;
  }[];
  /** Whose rows this viewer may change. Per team, because the All tab shows
   *  more than one and a lead may only touch their own. */
  editableTeams: number[];
  /** Free-for-all work is a lead's to pull, whichever team they lead. */
  canTakePool: boolean;
  stats: {
    total: number;
    unassigned: number;
    /** People on the team with nothing open — invisible on a board, because
     *  absence does not draw a card. */
    idle: { user_id: number; display_name: string; avatar: string; craft: string }[];
    byPriority: Record<string, number>;
    parked: number;
    pool: number;
    outside: number;
  };
  people: {
    user_id: number;
    craft: string;
    display_name: string;
    avatar: string;
    issues: QueueIssue[];
    urgent: number;
    inProgress: number;
    parked: number;
  }[];
  outside: TeamQueueData["people"];
  unassigned: QueueIssue[];
  pool: QueueIssue[];
  urgentCount: number;
  canEdit: boolean;
}

/** A hit from the header's search, with the line that matched it.
 *
 *  `matched` is absent when the words were in the summary — that is already on
 *  screen, and repeating it underneath would be noise. */
export interface SearchHit extends TrackerIssue {
  matched?: { where: "description" | "comment"; text: string };
}

/** What the event log says, rather than what is true right now.
 *  See docs/ANALYTICS.md. */
export interface InsightCard {
  key: string;
  label: string;
  value: number;
  unit: string;
  hint: string;
  /** Absent on a card with nothing to compare against. */
  trend?: { from: number; change: number | null };
  /** Which direction is the good one — the card knows, the trend does not. */
  better?: "up" | "down";
}

export interface InsightsOverview {
  days: number;
  cards: InsightCard[];
  throughput: {
    buckets: string[];
    created: number[];
    finished: number[];
    by_week: boolean;
  };
}

export interface InsightsFlow {
  days: number;
  /** The window, ISO. Charts plot against the period, not their own range. */
  from: string;
  to: string;
  /** Worst p85 first: the point is the status with the trapdoor. */
  waiting: {
    status: string; category: string; colour: string;
    median: number; p85: number; issues: number;
  }[];
  /** Statuses past the tenth, reported rather than silently dropped. */
  waiting_hidden: number;
  cycle: {
    points: { key: string; hours: number; at: string }[];
    median: number;
    p85: number;
  };
  actors: {
    buckets: string[];
    human: number[];
    automation: number[];
    integration: number[];
    by_week: boolean;
    automated_share: number;
    total: number;
  };
  moves: {
    from: string; to: string; total: number;
    human: number; automation: number; integration: number;
  }[];
  interruptions: {
    issue: string; for: string; reason: string; hours: number; open: boolean;
  }[];
}

export const trackerApi = {
  status: () => request<TrackerStatusInfo>("/api/nox/status"),

  setup: () =>
    request<{ ok: boolean; statuses: number; types: number; projects: number }>(
      "/api/nox/setup",
      { method: "POST" },
    ),

  meta: () => request<TrackerMeta>("/api/nox/meta"),

  /** A type's name, mark or colour. Global — this lands on every board. */
  patchType: (projectId: number, typeId: number,
              changes: { name?: string; icon?: string; colour?: string }) =>
    request<ProjectSettingsData>(
      `/api/nox/projects/${projectId}/types/${typeId}`,
      { method: "PATCH", body: JSON.stringify(changes) }),

  insightsOverview: (project?: string, days = 30) =>
    request<InsightsOverview>(
      `/api/nox/insights/overview?days=${days}${project ? `&project=${project}` : ""}`),

  insightsFlow: (project?: string, days = 30) =>
    request<InsightsFlow>(
      `/api/nox/insights/flow?days=${days}${project ? `&project=${project}` : ""}`),

  /** Every project, and summary + description + comments. */
  searchEverything: (term: string, limit = 25) =>
    request<SearchHit[]>(
      `/api/nox/search?q=${encodeURIComponent(term)}&limit=${limit}`),

  users: () => request<TrackerUser[]>("/api/nox/users"),

  // --- the work ---

  teams: () => request<TrackerTeam[]>("/api/nox/teams"),

  /** Demo only: put a slice of the seeded work on the calling account. */
  giveMeWork: () => request<{ work: MyWorkData }>("/api/nox/mock/give-me-work",
    { method: "POST" }).then((r) => r.work),

  myWork: (userId?: number) =>
    request<MyWorkData>(`/api/nox/my-work${userId ? `?user_id=${userId}` : ""}`),

  /** One team's backlog, or every team's when none is named. */
  teamQueue: (teamId?: number | null) => request<TeamQueueData>(
    `/api/nox/team-queue${teamId ? `?team_id=${teamId}` : ""}`),

  assign: (issueId: number, body: {
    assignee_id?: number | null; priority?: string; team_id?: number; set_team?: boolean;
  }) => request<TrackerIssue>(`/api/nox/issues/${issueId}/assign`, {
    method: "POST",
    body: JSON.stringify(body),
  }),

  setUrgent: (issueId: number, reason: string, urgent: boolean) =>
    request<TrackerIssue>(`/api/nox/issues/${issueId}/urgent`, {
      method: "POST",
      body: JSON.stringify({ reason, urgent }),
    }),

  reorderMyBand: (assigneeId: number, priority: string, issueIds: number[]) =>
    request<MyWorkData>("/api/nox/my-work/order", {
      method: "PUT",
      body: JSON.stringify({ assignee_id: assigneeId, priority, issue_ids: issueIds }),
    }),

  pauseIssue: (issueId: number, body: { for_issue_id?: number; reason?: string }) =>
    request<MyWorkData>(`/api/nox/issues/${issueId}/pause`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  resumeIssue: (issueId: number) =>
    request<MyWorkData>(`/api/nox/issues/${issueId}/resume`, { method: "POST" }),

  interruptions: (teamId?: number, days = 30) =>
    request<{ user_id: number; display_name: string; stops: number; hours: number }[]>(
      `/api/nox/interruptions?days=${days}${teamId ? `&team_id=${teamId}` : ""}`),

  projectStatuses: (projectId: number) =>
    request<TrackerStatus[]>(`/api/nox/projects/${projectId}/statuses`),

  // --- project settings (admin) ---

  projectSettings: (projectId: number) =>
    request<ProjectSettingsData>(`/api/nox/projects/${projectId}/settings`),

  patchProject: (projectId: number, patch: { name?: string; description?: string }) =>
    request<ProjectSettingsData>(`/api/nox/projects/${projectId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  setAccess: (projectId: number, visibility: string, entries: { kind: string; value: string }[]) =>
    request<ProjectSettingsData>(`/api/nox/projects/${projectId}/access`, {
      method: "PUT",
      body: JSON.stringify({ visibility, entries }),
    }),

  /** The whole column arrangement in one write — see admin.set_board. */
  setBoard: (projectId: number, columns: { name: string; status_ids: number[] }[]) =>
    request<ProjectSettingsData>(`/api/nox/projects/${projectId}/board`, {
      method: "PUT",
      body: JSON.stringify({ columns }),
    }),

  reorderColumns: (projectId: number, ids: number[]) =>
    request<ProjectSettingsData>(`/api/nox/projects/${projectId}/columns/order`, {
      method: "PUT",
      body: JSON.stringify({ ids }),
    }),

  addColumn: (projectId: number, statusId: number) =>
    request<ProjectSettingsData>(`/api/nox/projects/${projectId}/columns/${statusId}`, {
      method: "POST",
    }),

  removeColumn: (projectId: number, statusId: number) =>
    request<ProjectSettingsData>(`/api/nox/projects/${projectId}/columns/${statusId}`, {
      method: "DELETE",
    }),

  setTransition: (projectId: number, from: number, to: number, allowed: boolean) =>
    request<ProjectSettingsData>(`/api/nox/projects/${projectId}/transitions`, {
      method: "PUT",
      body: JSON.stringify({ from_status_id: from, to_status_id: to, allowed }),
    }),

  setLayout: (projectId: number, layout: Record<string, { x: number; y: number }>) =>
    request<ProjectSettingsData>(`/api/nox/projects/${projectId}/layout`, {
      method: "PUT",
      body: JSON.stringify({ layout }),
    }),

  renameTransition: (projectId: number, transitionId: number, name: string) =>
    request<ProjectSettingsData>(
      `/api/nox/projects/${projectId}/transitions/${transitionId}`,
      { method: "PATCH", body: JSON.stringify({ name }) },
    ),

  patchStatus: (
    projectId: number,
    statusId: number,
    patch: { name?: string; colour?: string; category?: string },
  ) => request<ProjectSettingsData>(
    `/api/nox/projects/${projectId}/statuses/${statusId}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  ),

  createStatus: (projectId: number, body: { name: string; category: string; colour: string }) =>
    request<ProjectSettingsData>(`/api/nox/projects/${projectId}/statuses`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  setTypes: (projectId: number, ids: number[]) =>
    request<ProjectSettingsData>(`/api/nox/projects/${projectId}/types`, {
      method: "PUT",
      body: JSON.stringify({ ids }),
    }),

  setTypeFields: (
    projectId: number,
    typeId: number,
    fields: { field_id: number; required: boolean }[],
  ) =>
    request<ProjectSettingsData>(`/api/nox/projects/${projectId}/types/${typeId}/fields`, {
      method: "PUT",
      body: JSON.stringify({ fields }),
    }),

  fields: () => request<FieldDefinition[]>("/api/nox/fields"),

  patchField: (id: number, patch: { name?: string; description?: string; reason?: string }) =>
    request<FieldDefinition>(`/api/nox/fields/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  archiveField: (id: number, archived: boolean) =>
    request<{ ok: boolean }>(`/api/nox/fields/${id}/archive?archived=${archived}`, {
      method: "POST",
    }),

  createField: (body: {
    key: string; name: string; kind: string; options?: string[]; reason?: string;
  }) => request<TrackerField>("/api/nox/fields", {
    method: "POST",
    body: JSON.stringify(body),
  }),

  linkTypes: () => request<LinkType[]>("/api/nox/link-types"),

  addLink: (issueId: number, kind: string, targetKey: string) =>
    request<TrackerIssue>(`/api/nox/issues/${issueId}/links`, {
      method: "POST",
      body: JSON.stringify({ kind, target_key: targetKey }),
    }),

  removeLink: (issueId: number, linkId: number) =>
    request<TrackerIssue>(`/api/nox/issues/${issueId}/links/${linkId}`, { method: "DELETE" }),

  setParent: (issueId: number, parentKey: string | null) =>
    request<TrackerIssue>(`/api/nox/issues/${issueId}/parent`, {
      method: "PUT",
      body: JSON.stringify({ parent_key: parentKey }),
    }),

  parentCandidates: (issueId: number, q = "") =>
    request<ParentCandidate[]>(
      `/api/nox/issues/${issueId}/parent-candidates${q ? `?q=${encodeURIComponent(q)}` : ""}`),

  archiveIssue: (id: number) =>
    request<{ ok: boolean }>(`/api/nox/issues/${id}`, { method: "DELETE" }),

  board: (view: {
    filter?: FilterNode | null;
    group_by?: string;
    sort?: SortSpec[];
    limit?: number;
    /** Which project's workflow supplies the columns. */
    project_id?: number | null;
  }) =>
    request<BoardData>("/api/nox/board", { method: "POST", body: JSON.stringify(view) }),

  search: (body: { filter?: FilterNode | null; sort?: SortSpec[]; limit?: number; offset?: number }) =>
    request<{ total: number; issues: TrackerIssue[] }>("/api/nox/issues/search", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  issue: (ident: string | number) =>
    request<TrackerIssue>(`/api/nox/issues/${encodeURIComponent(String(ident))}`),

  create: (body: {
    project_id: number;
    issue_type_id: number;
    summary: string;
    description?: string;
    assignee_id?: number | null;
    tester_id?: number | null;
    priority?: string;
    custom?: Record<string, unknown>;
  }) => request<TrackerIssue>("/api/nox/issues", { method: "POST", body: JSON.stringify(body) }),

  update: (id: number, patch: Record<string, unknown>) =>
    request<TrackerIssue>(`/api/nox/issues/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  /** Set the order inside one priority band of one board column. The whole
   *  band goes in one request — the server refuses anything that is not a
   *  rearrangement of exactly that band, which is what stops a medium being
   *  dropped above a high. */
  reorderBoard: (body: {
    project_id: number; status_ids: number[]; priority: string; issue_ids: number[];
  }) => request<{ ok: boolean }>("/api/nox/board/order", {
    method: "POST",
    body: JSON.stringify(body),
  }),

  gitStatus: () => request<GitStatus>("/api/nox/git/status"),

  /** Records the installation GitHub just created, after checking it is real. */
  gitConnected: (installationId: number) =>
    request<GitInstallation>(
      `/api/nox/git/connected?installation_id=${installationId}`,
      { method: "POST" }),

  gitDisconnect: (installationId: number) =>
    request<{ ok: boolean }>(`/api/nox/git/installations/${installationId}`,
      { method: "DELETE" }),

  gitSync: () => request<{ via: string; pull_requests: number; links: number }>(
    "/api/nox/git/sync", { method: "POST" }),

  transitions: (id: number) => request<TrackerTransition[]>(`/api/nox/issues/${id}/transitions`),

  transition: (id: number, statusId: number) =>
    request<TrackerIssue>(`/api/nox/issues/${id}/transition`, {
      method: "POST",
      body: JSON.stringify({ status_id: statusId }),
    }),

  comment: (id: number, body: string) =>
    request<TrackerComment>(`/api/nox/issues/${id}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    }),

  // --- releases ---

  releaseTimeline: () => request<TimelineData>("/api/nox/releases/timeline"),

  releases: (state?: string) =>
    request<ReleaseSummary[]>(`/api/nox/releases${state ? `?state=${state}` : ""}`),

  release: (id: number) => request<ReleaseDetail>(`/api/nox/releases/${id}`),

  createRelease: (body: {
    name: string;
    kind?: string;
    description?: string;
    planned_at?: string | null;
    cycle_start?: string | null;
  }) => request<ReleaseSummary>("/api/nox/releases", {
    method: "POST",
    body: JSON.stringify(body),
  }),

  patchRelease: (id: number, patch: Record<string, unknown>) =>
    request<ReleaseDetail>(`/api/nox/releases/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  addReleaseIssues: (id: number, body: { issue_ids?: number[]; filter?: FilterNode | null }) =>
    request<{ added: number; release: ReleaseDetail }>(`/api/nox/releases/${id}/issues`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  removeReleaseIssue: (releaseId: number, issueId: number) =>
    request<ReleaseDetail>(`/api/nox/releases/${releaseId}/issues/${issueId}`, {
      method: "DELETE",
    }),

  addArtifact: (releaseId: number, componentId: number, version: string) =>
    request<ReleaseDetail>(`/api/nox/releases/${releaseId}/artifacts`, {
      method: "POST",
      body: JSON.stringify({ component_id: componentId, version }),
    }),

  shipArtifact: (artifactId: number, shipped: boolean) =>
    request<ReleaseDetail>(`/api/nox/artifacts/${artifactId}/ship?shipped=${shipped}`, {
      method: "POST",
    }),

  addAction: (releaseId: number, title: string) =>
    request<ReleaseDetail>(`/api/nox/releases/${releaseId}/actions`, {
      method: "POST",
      body: JSON.stringify({ title }),
    }),

  completeAction: (actionId: number, done: boolean) =>
    request<ReleaseDetail>(`/api/nox/actions/${actionId}/done?done=${done}`, { method: "POST" }),

  removeAction: (actionId: number) =>
    request<ReleaseDetail>(`/api/nox/actions/${actionId}`, { method: "DELETE" }),

  draftNotes: (releaseId: number) =>
    request<{ notes: string }>(`/api/nox/releases/${releaseId}/notes/draft`).then((r) => r.notes),

  /** Candidates for a release of this kind — an issue may be on one of each. */
  unreleasedIssues: (q = "", kind?: string) => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (kind) p.set("kind", kind);
    const qs = p.toString();
    return request<UnreleasedIssue[]>(
      `/api/nox/unreleased-issues${qs ? `?${qs}` : ""}`);
  },

  components: () => request<TrackerComponent[]>("/api/nox/components"),

  createComponent: (body: { key: string; name: string; repo: string }) =>
    request<TrackerComponent>("/api/nox/components", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // --- automations ---

  automationBlocks: () => request<AutomationBlocks>("/api/nox/automation/blocks"),

  rules: () => request<AutomationRule[]>("/api/nox/automation/rules"),

  createRule: (body: Partial<AutomationRule>) =>
    request<AutomationRule>("/api/nox/automation/rules", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  patchRule: (id: number, patch: Partial<AutomationRule>) =>
    request<AutomationRule>(`/api/nox/automation/rules/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deleteRule: (id: number) =>
    request<{ ok: boolean }>(`/api/nox/automation/rules/${id}`, { method: "DELETE" }),

  ruleRuns: (id: number) =>
    request<AutomationRun[]>(`/api/nox/automation/rules/${id}/runs`),

  dryRun: (id: number, entityType: string, entityId: number) =>
    request<{ outcome: string; conditions: boolean; steps: Record<string, any>[]; error: string }>(
      `/api/nox/automation/rules/${id}/dry-run`,
      { method: "POST", body: JSON.stringify({ entity_type: entityType, entity_id: entityId }) },
    ),
};

// ------------------------------------------------------------------ helpers --

export const PRIORITIES = ["highest", "high", "medium", "low", "lowest"] as const;

// Epics need telling apart at a glance, and the type's own colour cannot do it
// — every epic shares it. So the colour comes from the parent's key: stable
// across every board and every session, and free of a column to maintain. If
// somebody ever wants to *choose* an epic's colour, that becomes a stored field
// and this becomes its default.
const PARENT_COLOURS = [
  "#8957e5", "#1f6feb", "#3fb950", "#d29922",
  "#db6d28", "#39c5cf", "#db61a2", "#a371f7",
];

export function parentColour(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return PARENT_COLOURS[hash % PARENT_COLOURS.length];
}

export const PRIORITY_COLOUR: Record<string, string> = {
  // Urgent is not one of the five — it sits above them — but it still needs a
  // colour wherever the six are listed together.
  urgent: "var(--err)",
  highest: "#f85149",
  high: "#f0883e",
  medium: "#8b949e",
  low: "#58a6ff",
  lowest: "#6e7681",
};

/** A field name as a person would read it: `custom.utility_points` → "Utility points". */
export function fieldLabel(field: string, fields: TrackerField[] = []): string {
  if (field.startsWith("custom.")) {
    const key = field.slice(7);
    const known = fields.find((f) => f.key === key);
    if (known) return known.name;
    return key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  }
  return (
    {
      status_id: "Status",
      assignee_id: "Assignee",
      reporter_id: "Reporter",
      issue_type_id: "Type",
      parent_id: "Parent",
      summary: "Summary",
      description: "Description",
      priority: "Priority",
      rank: "Order",
      estimate: "Estimate",
      archived_at: "Archived",
    }[field] ?? field.replace(/_/g, " ")
  );
}

/** "3 hours ago" — activity feeds are read relatively, not by timestamp. */
export function ago(iso: string): string {
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "just now";
  const mins = secs / 60;
  if (mins < 60) return `${Math.floor(mins)}m ago`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = hours / 24;
  if (days < 30) return `${Math.floor(days)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function initials(name: string): string {
  const parts = name.replace(/[._]/g, " ").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || name.slice(0, 2).toUpperCase();
}
