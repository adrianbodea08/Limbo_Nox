"""Demo data, so the tracker can be looked at rather than described.

Everything here is invented — the people are not real colleagues and the issues
are not real work. What is *not* invented is the shape: issues move through the
workflow their own board actually has, so Classic Dev really does pass through
Staging on its way to Live and AI First Development really does climb seventeen
gates. A demo that used one generic To Do / Doing / Done would have hidden the
one thing worth looking at.

History is backdated. Issues are created over the past few months and then
walked forward status by status with the events written at the time each move
happened, so the activity feed, "updated 3d ago" and time-in-status all read
like a board that has been used rather than one seeded a minute ago.

Idempotent by way of `reset`: generating twice wipes the tracker's own tables
first. It never touches anything outside the tracker database.
"""
from __future__ import annotations

import random
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import Connection, select, text

from . import git as git_module, links as link_module, releases as rel, repo, work
from .repo import Actor, TrackerError
from .schema import (
    automation_rules, comments, components, events, issue_types, issues,
    projects, statuses, team_members, teams, users,
)

# A fixed seed so two runs produce the same board. A demo that reshuffles every
# time is impossible to talk about with someone.
SEED = 20260806

# --------------------------------------------------------------------- people

# Invented people. Names are Romanian and Moldovan in roughly the mix the team
# has, so the board looks plausible rather than like a US tutorial.
# name, craft, team. Two delivery teams, a PO over both, and DevOps outside
# them — they sit with their own board, which is a separate arrangement.
PEOPLE = [
    ("Andrei Lupescu",   "dev",  "ROCKET"),
    ("Ioana Marinescu",  "dev",  "ROCKET"),
    ("Cristian Dobre",   "dev",  "ROCKET"),
    ("Elena Vasilache",  "dev",  "ROCKET"),
    ("Bogdan Ilie",      "ai",   "ROCKET"),
    ("Diana Popovici",   "qa",   "ROCKET"),
    ("Paul Grigore",     "lead", "ROCKET"),

    ("Radu Ionescu",     "dev",  "SPARTA"),
    ("Tudor Panaite",    "dev",  "SPARTA"),
    ("Alexandra Neagu",  "ai",   "SPARTA"),
    ("Ștefan Cojocaru",  "ai",   "SPARTA"),
    ("Vlad Ceban",       "qa",   "SPARTA"),
    ("Raluca Mihu",      "qa",   "SPARTA"),
    ("Mihaela Cîrstea",  "lead", "SPARTA"),

    ("George Anton",     "ops",  None),
    ("Silvia Rusu",      "ops",  None),
    ("Ana Mihalache",    "po",   None),
]

TEAMS = [
    ("ROCKET", "Rocket", "#f0883e", "Paul Grigore"),
    ("SPARTA", "Sparta", "#5b8cff", "Mihaela Cîrstea"),
]

# Profile pictures are generated as data URIs rather than fetched.
#
# An external avatar service would mean the demo looks broken on any machine
# without internet — and a board full of grey squares is a worse demo than no
# board. These are deterministic from the name, so a person keeps their face.
AVATAR_PALETTE = [
    ("#5b8cff", "#8b5bff"), ("#3fb950", "#2dd4bf"), ("#f0883e", "#f85149"),
    ("#a371f7", "#f778ba"), ("#d29922", "#f0883e"), ("#2dd4bf", "#5b8cff"),
    ("#f778ba", "#a371f7"), ("#3fb950", "#5b8cff"),
]


def _initials(name: str) -> str:
    parts = [p for p in name.replace("-", " ").split() if p]
    return ((parts[0][0] if parts else "") + (parts[1][0] if len(parts) > 1 else "")).upper()


def avatar_for(name: str, index: int) -> str:
    """A small SVG portrait: gradient field, a head-and-shoulders silhouette,
    and the person's initials. Enough to tell sixteen people apart at 22px."""
    a, b = AVATAR_PALETTE[index % len(AVATAR_PALETTE)]
    rot = (index * 37) % 360
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">'
        f'<defs><linearGradient id="g" gradientTransform="rotate({rot} .5 .5)">'
        f'<stop offset="0" stop-color="{a}"/><stop offset="1" stop-color="{b}"/>'
        f'</linearGradient></defs>'
        f'<rect width="80" height="80" fill="url(#g)"/>'
        f'<circle cx="40" cy="31" r="14" fill="#ffffff" opacity=".28"/>'
        f'<path d="M12 80c0-17 12.5-26 28-26s28 9 28 26z" fill="#ffffff" opacity=".28"/>'
        f'<text x="40" y="47" font-family="Inter,system-ui,sans-serif" font-size="26" '
        f'font-weight="700" fill="#ffffff" text-anchor="middle">{_initials(name)}</text>'
        f'</svg>'
    )
    # A data URI keeps it self-contained; SVG needs only these two escaped.
    return "data:image/svg+xml;charset=utf-8," + svg.replace("#", "%23").replace('"', "'")


# ---------------------------------------------------------------------- work
# Summaries per board, written to sound like the work each one actually does.

WORK = {
    "CD": [
        ("story", "Split the checkout total into net, VAT and shipping"),
        ("story", "Let a pharmacy save more than one delivery address"),
        ("task",  "Retire the legacy price-list importer"),
        ("task",  "Move product images to the CDN and drop the local cache"),
        ("bug",   "Order confirmation email renders the wrong currency"),
        ("bug",   "Netopia callback times out on orders above 40 lines"),
        ("defect", "Discount applies twice when a voucher is re-entered"),
        ("live_bug", "Stock counter goes negative on concurrent checkout"),
        ("hotfix", "Restore VAT rate for medical devices"),
        ("addon_task", "Add SmartBill invoice numbering to the order export"),
        ("task",  "Paginate the order history endpoint"),
        ("story", "Reorder-from-history in two clicks"),
        ("bug",   "Search ignores diacritics in product names"),
        ("task",  "Rate-limit the public catalogue API"),
        ("epic",  "Checkout rebuild"),
        ("story", "Show delivery estimates per warehouse"),
        ("task",  "Backfill missing SKU barcodes"),
        ("defect", "PDF invoice misses the second page of long orders"),
    ],
    "AIF": [
        ("story", "Prompt evaluation harness with a scored regression set"),
        ("story", "Retrieval over the product monograph corpus"),
        ("task",  "Cache embeddings per document version"),
        ("task",  "Token budget guard on the summarisation endpoint"),
        ("story", "Draft answers for the pharmacist support inbox"),
        ("task",  "Nightly eval run posts its diff to the channel"),
        ("story", "Interaction checker over the active-substance graph"),
        ("task",  "Fall back to the smaller model when latency spikes"),
        ("epic",  "Assistant for pharmacy staff"),
        ("story", "Cite the monograph section behind every answer"),
        ("task",  "Redact personal data before it reaches the model"),
        ("story", "Rank search results with the reranker"),
    ],
    "QAB": [
        ("task", "Automate the password reset flow"),
        ("task", "Regression pass for release B-34"),
        ("task", "Manual Testing for [B-34]"),
        ("bug",  "Test data seeder leaves orphaned accounts"),
        ("task", "Smoke suite against staging after every deploy"),
        ("task", "Cross-browser check on the checkout"),
        ("story", "Test plan for the assistant answers"),
        ("bug",  "Flaky test: cart total assertion races the price update"),
        ("task", "Accessibility pass on the order forms"),
        ("task", "Load test the catalogue at 4x peak"),
        ("epic", "Coverage for the checkout rebuild"),
    ],
    "DVO": [
        ("task", "Move the tracker database off the shared host"),
        ("task", "Alert when a nightly snapshot fails twice running"),
        ("task", "Rotate the Vault unseal keys"),
        ("bug",  "Runner disk fills during image builds"),
        ("task", "Terraform the staging environment"),
        ("story", "Blue-green deploys for the API"),
        ("task", "Ship container logs to the aggregator"),
        ("task", "Renew the wildcard certificate"),
        ("bug",  "Backup restore takes 40 minutes and nobody knew"),
    ],
}

COMMENTS = [
    "Reproduced on staging — same payload, same result.",
    "Picking this up today.",
    "Blocked on the API change landing first.",
    "Fixed in the branch, waiting for review.",
    "Talked it through with the team; splitting into two.",
    "This is the third report of the same thing this month.",
    "Tested on staging, looks right now.",
    "Needs a decision from product before it can move.",
    "Deployed. Watching the error rate.",
    "Turned out to be a config problem, not a code one.",
    "Adding the regression test so it cannot come back.",
    "Rolled back — the fix broke the invoice PDF.",
]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def reset(conn: Connection) -> None:
    """Empty the tracker's own tables. Nothing outside them is touched.

    The workflow tables go too, not just the issues. `seed.run` is idempotent —
    it creates what is missing and leaves what exists — which means an old
    generic workflow would survive a reseed and quietly keep its projects
    pointed at itself. Clearing them is what makes "regenerate" actually pick
    up a changed capture.

    `projects` is kept: it is what everything else hangs off, and seed finds it
    again by key.
    """
    conn.execute(text("""
        TRUNCATE release_issues, release_artifacts, release_actions, releases,
                 components, automation_runs, automation_jobs, automation_rules,
                 comments, events, issue_pauses, issues, worker_state,
                 team_members, teams,
                 transitions, workflow_statuses, project_workflows, workflows,
                 project_issue_types, issue_types, statuses, views
        RESTART IDENTITY CASCADE
    """))
    conn.execute(projects.update().values(issue_seq=0))


def _people(conn: Connection) -> list[dict]:
    """Create the demo accounts in the tracker's user projection.

    Deliberately only here: these are not app logins, and inventing sixteen
    real accounts to look at a board would be a mess to clean up afterwards.
    Ids start high so they cannot collide with a genuine account id.
    """
    made = []
    for i, (name, craft, team_key) in enumerate(PEOPLE):
        uid = 900_000 + i
        exists = conn.execute(select(users.c.id).where(users.c.id == uid)).scalar()
        values = {"display_name": name, "avatar": avatar_for(name, i), "active": True}
        if exists is None:
            conn.execute(users.insert().values(id=uid, **values))
        else:
            conn.execute(users.update().where(users.c.id == uid).values(**values))
        made.append({"id": uid, "name": name, "role": craft, "team_key": team_key})

    by_name = {p["name"]: p for p in made}
    for pos, (key, name, colour, lead_name) in enumerate(TEAMS):
        team_id = conn.execute(teams.insert().values(
            key=key, name=name, colour=colour, position=pos,
            lead_id=by_name[lead_name]["id"],
        ).returning(teams.c.id)).scalar_one()
        for person in made:
            if person["team_key"] == key:
                conn.execute(team_members.insert().values(
                    team_id=team_id, user_id=person["id"],
                    craft="lead" if person["name"] == lead_name else person["role"]))
                person["team_id"] = team_id
    return made


def generate(conn: Connection, *, wipe: bool = True) -> dict:
    """Fill the tracker with a board's worth of plausible history."""
    from . import seed

    rng = random.Random(SEED)
    if wipe:
        reset(conn)
    # Seed after the wipe, never before: the wipe is what lets a changed
    # capture take effect.
    seed.run(conn)

    people = _people(conn)
    by_role = {r: [p for p in people if p["role"] == r] for r in ("dev", "ai", "qa", "ops", "lead", "po")}
    pool = {"CD": by_role["dev"] + by_role["lead"],
            "AIF": by_role["ai"] + by_role["lead"],
            "QAB": by_role["qa"],
            "DVO": by_role["ops"]}
    team_ids = [t[0] for t in conn.execute(select(teams.c.id).order_by(teams.c.position)).all()]

    project_rows = {r["key"]: dict(r) for r in conn.execute(select(projects)).mappings()}
    type_ids = {r["key"]: r["id"] for r in conn.execute(select(issue_types)).mappings()}
    status_rows = {r["key"]: dict(r) for r in conn.execute(select(statuses)).mappings()}

    from .jira_workflows import WORKFLOWS

    made: list[dict] = []
    now = _now()

    for pkey, items in WORK.items():
        project = project_rows[pkey]
        flow = [s for s in WORKFLOWS[pkey]["statuses"] if s not in ("wont_do", "won't_do")]
        # Where each issue has got to. Weighted so a board looks like real work
        # in flight: a tail of finished things, a bulge in the middle, a queue.
        for index, (type_key, summary) in enumerate(items):
            author = rng.choice(pool[pkey])
            actor = Actor(id=author["id"], kind="human")

            age_days = rng.randint(3, 110)
            created = now - timedelta(days=age_days, hours=rng.randint(0, 20))

            custom = {}
            if pkey == "QAB":
                custom["feature_utility_points"] = rng.choice([1, 2, 3, 5, 8, 13])
            elif type_key not in ("epic", "subtask"):
                custom["utility_points"] = rng.choice([1, 2, 3, 3.29, 5, 8, 13])

            # Most work belongs to a team; roughly one in six is left for
            # either to take, which is the free-for-all pool a lead pulls from.
            owner = author if author.get("team_id") else rng.choice(
                [p for p in people if p.get("team_id")])
            # DevOps runs its own board and is not one of the two delivery
            # teams — that arrangement is a separate conversation, so its work
            # carries no team rather than a wrong one.
            team_id = (None if pkey == "DVO" or rng.random() < 0.16
                       else owner.get("team_id"))
            # An issue nobody has picked up yet has no assignee — that is the
            # lead's inbox, and the demo needs some or the screen looks solved.
            #
            # Whoever gets it has to be on the team that owns it, with the right
            # craft for the board. Assigning across teams is legal and the lead
            # screen shows it, but it should be the exception it is in practice
            # rather than half the roster.
            candidates = [p for p in pool[pkey] if p.get("team_id") == team_id]
            if not candidates:
                candidates = [p for p in people if p.get("team_id") == team_id]
            assignee = (rng.choice(candidates)["id"]
                        if team_id and candidates and rng.random() > 0.28 else None)

            # Who verifies it. QA by preference, and never the person who wrote
            # it — an issue whose tester is its author is exactly the case the
            # card warns about, so the demo should not be full of them.
            testers = [p for p in by_role["qa"] if p["id"] != assignee]
            tester = (rng.choice(testers)["id"]
                      if testers and rng.random() > 0.45 else None)

            issue = repo.create_issue(
                conn, actor,
                project_id=project["id"],
                issue_type_id=type_ids[type_key],
                status_id=status_rows[flow[0]]["id"],
                summary=summary,
                description=_description(summary, rng),
                reporter_id=author["id"],
                assignee_id=assignee,
                tester_id=tester,
                team_id=team_id,
                priority=rng.choices(
                    ["highest", "high", "medium", "low", "lowest"],
                    weights=[1, 3, 6, 3, 1])[0],
                plan_priority=rng.choices(
                    ["highest", "high", "medium", "low"],
                    weights=[1, 3, 5, 2])[0],
                custom=custom,
                created_at=created,
                updated_at=created,
            )
            # Backdate the creation event to match the issue.
            conn.execute(events.update()
                         .where(events.c.entity_id == issue["id"])
                         .where(events.c.entity_type == "issue")
                         .values(at=created))

            # How far along it got. Older issues have travelled further.
            reach = min(len(flow) - 1, int((age_days / 110) * len(flow) * rng.uniform(0.5, 1.35)))
            if rng.random() < 0.08:
                reach = 0
            # Six issues in ten stay short of a done status. A demo where most
            # of the work has shipped shows empty queues, which is the one thing
            # these screens must not look like.
            first_done = next((n for n, key in enumerate(flow)
                               if status_rows[key]["category"] == "done"), len(flow))
            if rng.random() < 0.6 and first_done:
                reach = min(reach, first_done - 1)
            at = created
            for step in range(1, reach + 1):
                at = at + timedelta(days=rng.uniform(0.4, 6.0), hours=rng.uniform(0, 9))
                if at > now:
                    break
                _move(conn, actor, issue["id"], status_rows[flow[step]]["id"], at)

            # A few get abandoned rather than finished.
            if rng.random() < 0.05 and "wont_do" in status_rows:
                at = min(now, at + timedelta(days=rng.uniform(1, 8)))
                _move(conn, actor, issue["id"], status_rows["wont_do"]["id"], at)

            for _ in range(rng.choices([0, 1, 2, 3], weights=[4, 4, 2, 1])[0]):
                when = created + timedelta(days=rng.uniform(0.2, max(0.4, (at - created).days or 1)))
                speaker = rng.choice(pool[pkey])
                cid = repo.add_comment(conn, Actor(id=speaker["id"], kind="human"),
                                       issue["id"], rng.choice(COMMENTS))
                conn.execute(comments.update().where(comments.c.id == cid["id"])
                             .values(created_at=min(when, now)))
            made.append(issue)

    _releases(conn, rng, people, project_rows, made, now)
    _automations(conn, project_rows, type_ids, status_rows)
    urgent, parked = _interruptions(conn, rng, people, made, now)
    branches, pulls = _git(conn, rng, people, made, now)
    family, linked = _relationships(conn, rng, people, made)
    _board_shape(conn, project_rows)

    return {
        "people": len(people),
        "parented": family,
        "links": linked,
        "branches": branches,
        "pullRequests": pulls,
        "teams": len(TEAMS),
        "issues": len(made),
        "urgent": urgent,
        "parked": parked,
        "projects": list(WORK.keys()),
    }


def give_to(conn: Connection, user_id: int, *, team_key: str = "ROCKET") -> dict:
    """Hand a real account a slice of work, so My work has something on it.

    Written against whoever asks rather than a fixed id: the point is to look at
    your own screen, and every environment has different accounts. Safe to run
    again — it tops up rather than duplicating, and only ever touches open,
    unassigned work that already belongs to the team.
    """
    rng = random.Random(SEED + user_id)
    team = conn.execute(select(teams).where(teams.c.key == team_key)).mappings().first()
    if team is None:
        raise ValueError(f"no team {team_key}")

    on_team = conn.execute(
        select(team_members.c.user_id)
        .where(team_members.c.team_id == team["id"])
        .where(team_members.c.user_id == user_id)).scalar()
    if on_team is None:
        conn.execute(team_members.insert().values(
            team_id=team["id"], user_id=user_id, craft="dev"))

    actor = Actor(id=user_id, kind="human")
    lead = conn.execute(select(teams.c.lead_id).where(teams.c.id == team["id"])).scalar()
    lead_actor = Actor(id=lead, kind="human")

    already = conn.execute(text("""
        SELECT count(*) FROM issues i JOIN statuses s ON s.id = i.status_id
         WHERE i.assignee_id = :u AND s.category <> 'done' AND i.archived_at IS NULL
    """), {"u": user_id}).scalar_one()

    wanted = max(0, 6 - already)
    picked = [r[0] for r in conn.execute(text("""
        SELECT i.id FROM issues i JOIN statuses s ON s.id = i.status_id
         WHERE i.assignee_id IS NULL AND s.category <> 'done'
           AND i.archived_at IS NULL AND i.team_id = :t
         ORDER BY i.id LIMIT :n
    """), {"t": team["id"], "n": wanted}).all()]

    # Not enough unassigned work on the team: take some free-for-all instead,
    # which is what a lead would do.
    if len(picked) < wanted:
        picked += [r[0] for r in conn.execute(text("""
            SELECT i.id FROM issues i JOIN statuses s ON s.id = i.status_id
             WHERE i.assignee_id IS NULL AND s.category <> 'done'
               AND i.archived_at IS NULL AND i.team_id IS NULL
             ORDER BY i.id LIMIT :n
        """), {"n": wanted - len(picked)}).all()]

    for n, issue_id in enumerate(picked):
        conn.execute(issues.update().where(issues.c.id == issue_id)
                     .values(team_id=team["id"]))
        work.assign(conn, lead_actor, issue_id,
                    assignee_id=user_id,
                    priority=["highest", "high", "high", "medium", "medium", "low"][n % 6])

    mine = [r[0] for r in conn.execute(text("""
        SELECT i.id FROM issues i JOIN statuses s ON s.id = i.status_id
         WHERE i.assignee_id = :u AND s.category <> 'done' AND i.archived_at IS NULL
         ORDER BY i.id
    """), {"u": user_id}).all()]

    # Two of them in progress, so the screen has a middle band and something to
    # park when the urgent lands.
    in_progress = conn.execute(text("""
        SELECT s.id FROM statuses s JOIN workflow_statuses ws ON ws.status_id = s.id
         JOIN project_workflows pw ON pw.workflow_id = ws.workflow_id
         WHERE s.category = 'in_progress' AND pw.project_id = (
               SELECT project_id FROM issues WHERE id = :i)
         ORDER BY ws.position LIMIT 1
    """), {"i": mine[0]}).scalar() if mine else None
    for issue_id in mine[:2]:
        if in_progress:
            try:
                repo.update_issue(conn, actor, issue_id, {"status_id": in_progress})
            except Exception:  # noqa: BLE001 - a workflow that will not allow it is fine
                pass

    urgent_key = None
    if len(mine) > 2:
        target = mine[2]
        work.set_urgent(conn, lead_actor, target,
                        reason="Pharmacy support has three tickets open on this.")
        urgent_key = conn.execute(select(issues.c.key).where(issues.c.id == target)).scalar()
        # And something put down for it, so the parked band and the
        # interruption figure both have something real in them.
        if mine[0] != target and not work.open_pause(conn, mine[0]):
            work.pause(conn, actor, mine[0], for_issue_id=target,
                       reason="Picked up the urgent one.")

    # A few finished ones too, or the Done column is empty on a screen whose
    # whole point is that a week should not end showing only what is left.
    recent = [r[0] for r in conn.execute(text("""
        SELECT i.id FROM issues i JOIN statuses s ON s.id = i.status_id
         WHERE s.category = 'done' AND i.archived_at IS NULL
           AND i.assignee_id IS DISTINCT FROM :u
           -- Actually finished, not abandoned: a Done column of nothing but
           -- "Won't Do" is a demo of the wrong thing.
           AND s.key <> 'wont_do'
         ORDER BY i.resolved_at DESC NULLS LAST LIMIT 3
    """), {"u": user_id}).all()]
    for n, issue_id in enumerate(recent):
        conn.execute(issues.update().where(issues.c.id == issue_id).values(
            assignee_id=user_id, team_id=team["id"],
            # Demo data: pull the finish date into the window the column shows.
            resolved_at=text(f"now() - interval '{n + 1} days'")))

    return {"team": team["name"], "assigned": len(mine),
            "urgent": urgent_key, "topped_up": len(picked),
            "done": len(recent)}


def _git(conn, rng, people, made, now) -> tuple[int, int]:
    """Branches and pull requests against the demo issues.

    Without these the development panel is an empty box on every issue, and the
    board's PR badge never appears — so the half of the workflow this exists to
    carry is invisible in the demo. The states are spread on purpose: an open
    PR with a green build, one with a red one, a merged one, and a branch with
    no PR yet, because those are the four things a person reads the panel to
    tell apart.
    """
    lead = Actor(id=people[0]["id"], kind="human")
    handles = ["alexb", "mihaelac", "radui", "elenav", "andreil"]
    repos = ["drcarmen/backend", "drcarmen/web", "drcarmen/drc-android"]

    # Issues that are actually being worked on are the ones with branches.
    working = [i for i in made if i["id"] % 3 != 0][:16]
    branches = pulls = 0
    for index, issue in enumerate(working):
        repo_name = repos[index % len(repos)]
        slug = issue["summary"].lower().split()
        branch = f"feature/{issue['key']}-{'-'.join(slug[:3])}"[:60]

        git_module.record(
            conn, repo.SYSTEM, kind="branch", repo_name=repo_name, ref=branch,
            title=branch, branch=branch,
            url=f"https://github.com/{repo_name}/tree/{branch}",
            found={"branch": {issue["key"]}})
        branches += 1

        # Every fourth issue stops at a branch: work started, no PR yet.
        if index % 4 == 3:
            continue

        state, checks = [
            ("open", "passing"), ("open", "failing"), ("merged", "passing"),
            ("draft", "pending"), ("merged", "passing"), ("closed", "none"),
        ][index % 6]
        opened = now - timedelta(days=rng.randint(1, 12), hours=rng.randint(0, 20))
        git_module.record(
            conn, repo.SYSTEM, kind="pr", repo_name=repo_name,
            ref=str(120 + index),
            title=f"{issue['key']} {issue['summary']}"[:90],
            url=f"https://github.com/{repo_name}/pull/{120 + index}",
            state=state, checks=checks, author=handles[index % len(handles)],
            branch=branch, opened_at=opened,
            merged_at=opened + timedelta(days=1) if state == "merged" else None,
            found={"title": {issue["key"]}})
        pulls += 1
    return branches, pulls


def _relationships(conn, rng, people, made) -> tuple[int, int]:
    """Epics with children, and issues that get in each other's way.

    Without these the hierarchy and the links are features with nothing in them,
    and "blocked by" in particular cannot be judged from an empty screen — the
    whole point of it is what it does to a queue.
    """
    lead = Actor(id=[p for p in people if p["role"] == "lead"][0]["id"], kind="human")
    by_key = {i["key"]: i for i in made}

    levels = dict(conn.execute(
        select(issue_types.c.id, issue_types.c.hierarchy_level)).all())
    epics = [i for i in made if levels.get(i["issue_type_id"], 0) >= 2]

    parented = 0
    for epic in epics:
        # Children from the same board, one level down, a handful each.
        siblings = [i for i in made
                    if i["project_id"] == epic["project_id"]
                    and levels.get(i["issue_type_id"], 0) == 1
                    and i["id"] != epic["id"]]
        for child in siblings[:rng.randint(2, 4)]:
            try:
                link_module.set_parent(conn, lead, child["id"], epic["id"])
                parented += 1
            except (link_module.LinkError, TrackerError):
                continue

    # Links chosen to read like real ones rather than random pairs.
    wanted = [
        ("CD-6", "blocks", "CD-1"),
        ("CD-13", "blocks", "CD-11"),
        ("AIF-2", "blocks", "AIF-5"),
        ("DVO-1", "blocks", "CD-4"),
        ("CD-5", "relates", "CD-18"),
        ("QAB-2", "relates", "CD-12"),
        ("CD-7", "duplicates", "CD-18"),
        ("QAB-8", "causes", "QAB-5"),
    ]
    linked = 0
    for source, kind, target in wanted:
        a, b = by_key.get(source), by_key.get(target)
        if not a or not b:
            continue
        try:
            link_module.add(conn, lead, a["id"], b["id"], kind)
            linked += 1
        except (link_module.LinkError, TrackerError):
            continue
    return parented, linked


def _board_shape(conn, project_rows) -> None:
    """Lay out every board.

    Each project gets a real column layout rather than relying on the
    "no layout yet" fallback, because a layout is what a project would have in
    practice and the fallback should be the thing nobody ever sees.

    Classic Dev is the exception, laid out by hand: two statuses under one
    heading and one status in no column at all, so the board model has
    something to demonstrate beyond one column per status.
    """
    from . import admin
    from .jira_workflows import WORKFLOWS

    ids = dict(conn.execute(select(statuses.c.key, statuses.c.id)).all())
    names = dict(conn.execute(select(statuses.c.key, statuses.c.name)).all())

    cd = project_rows.get("CD")
    if cd:
        admin.set_board(conn, cd["id"], [
            {"name": "To Do", "status_ids": [ids["to_do"]]},
            {"name": "In Progress", "status_ids": [ids["in_progress"]]},
            {"name": "In Review", "status_ids": [ids["in_review"]]},
            {"name": "Unified / Staging", "status_ids": [ids["staging"], ids["unified"]]},
            {"name": "Live", "status_ids": [ids["live"]]},
            {"name": "Done", "status_ids": [ids["done"]]},
            # Won't Do deliberately in no column: its issues stay off the board.
        ])

    # The rest: one column per status, in the workflow's own order, which is
    # what a board looks like before anybody has opinions about it.
    for key, project in project_rows.items():
        if key == "CD" or key not in WORKFLOWS:
            continue
        admin.set_board(conn, project["id"], [
            {"name": names[status], "status_ids": [ids[status]]}
            for status in WORKFLOWS[key]["statuses"] if status in ids
        ])


def _interruptions(conn, rng, people, made, now) -> tuple[int, int]:
    """A couple of urgent bugs, and the work they interrupted.

    Without these the screens look like a team that has never been interrupted,
    which is not a useful thing to review a design against.
    """
    leads = [p for p in people if p["role"] == "lead"]
    # Only open, team-owned, assigned work can sensibly be urgent — an urgent
    # bug nobody holds and nobody can see is not a demo of anything.
    open_ids = {r[0] for r in conn.execute(text("""
        SELECT i.id FROM issues i JOIN statuses s ON s.id = i.status_id
         WHERE s.category <> 'done' AND i.archived_at IS NULL
           AND i.assignee_id IS NOT NULL AND i.team_id IS NOT NULL
    """)).all()}
    bugs = [i for i in made if i["id"] in open_ids]
    rng.shuffle(bugs)

    urgent_count = 0
    parked_count = 0
    for bug in bugs[:2]:
        lead = rng.choice(leads)
        actor = Actor(id=lead["id"], kind="human")
        work.set_urgent(conn, actor, bug["id"],
                        reason=rng.choice([
                            "Reported by three pharmacies this morning.",
                            "Blocking the B-34 regression pass.",
                        ]))
        conn.execute(issues.update().where(issues.c.id == bug["id"])
                     .values(urgent_at=now - timedelta(hours=rng.randint(2, 30))))
        urgent_count += 1

        # What the same person put down to take it. This is the pause the
        # interruption number is built from.
        theirs = [i for i in made
                  if i["assignee_id"] == bug["assignee_id"]
                  and i["id"] != bug["id"] and i["id"] in open_ids]
        for victim in theirs[:2]:
            started = now - timedelta(hours=rng.randint(2, 26))
            pause_id = conn.execute(text("""
                INSERT INTO issue_pauses (issue_id, paused_by, paused_for_issue_id,
                                          reason, paused_at, resumed_at)
                VALUES (:i, :by, :for_id, :reason, :at, :resumed)
                RETURNING id
            """), {"i": victim["id"], "by": bug["assignee_id"], "for_id": bug["id"],
                   "reason": "Picked up the urgent bug.", "at": started,
                   # One is still parked, one was picked back up — both states
                   # need to be visible on the screens.
                   "resumed": None if parked_count % 2 == 0
                   else started + timedelta(hours=rng.randint(1, 6))}).scalar_one()
            repo.write_event(conn, Actor(id=bug["assignee_id"], kind="human"),
                             entity_type="issue", entity_id=victim["id"],
                             batch_id=repo.new_batch(conn), kind="paused",
                             payload={"pause_id": pause_id, "for_issue_id": bug["id"]},
                             at=started)
            parked_count += 1
    return urgent_count, parked_count


def _description(summary: str, rng: random.Random) -> str:
    return rng.choice([
        f"{summary}.\n\nReported by support. Reproducible on the current build.",
        f"{summary}.\n\nAgreed in refinement. Acceptance: the behaviour holds "
        f"for an empty basket and for one with 200 lines.",
        f"{summary}.\n\nSplit out of the epic so it can ship on its own.",
        f"{summary}.",
    ])


def _move(conn: Connection, actor: Actor, issue_id: int, status_id: int, at: datetime) -> None:
    """Move an issue and backdate both the row and its event.

    Goes through repo.update_issue rather than writing SQL, so the demo data
    exercises the same path real work does — including the resolved_at rule.
    """
    before = conn.execute(select(events.c.id).order_by(events.c.id.desc()).limit(1)).scalar() or 0
    repo.update_issue(conn, actor, issue_id, {"status_id": status_id})
    conn.execute(events.update().where(events.c.id > before)
                 .where(events.c.entity_id == issue_id).values(at=at))
    conn.execute(issues.update().where(issues.c.id == issue_id).values(updated_at=at))
    # resolved_at was stamped now(); it belongs at the moment of the move.
    conn.execute(text(
        "UPDATE issues SET resolved_at = :at WHERE id = :id AND resolved_at IS NOT NULL"
    ), {"at": at, "id": issue_id})


# Real release windows, read from Jira on 2026-08-19 and kept as they are.
#
# Invented release data agrees with whoever invented it. These are the real
# shapes the timeline has to survive: a 35-day release next to a same-day
# hotfix, releases carrying one artifact and fifteen, and windows that overlap
# three deep. The dates are shifted so the set always straddles today.
CAPTURED_ON = date(2026, 8, 19)

REAL_COMPONENTS = [
    ('a', 'A'),
    ('accounting', 'Accounting'),
    ('b', 'B'),
    ('courier_base', 'Courier Base'),
    ('dai', 'DAI'),
    ('dai_android', 'DAI Android'),
    ('dai_ios', 'DAI iOS'),
    ('drc_android', 'DRC Android'),
    ('drc_ios', 'DRC iOS'),
    ('f', 'F'),
    ('g', 'G'),
    ('lopp_android', 'LOPP Android'),
    ('lopp_ios', 'LOPP iOS'),
    ('notification', 'Notification'),
    ('storage', 'STORAGE'),
    ('stats', 'Stats'),
    ('store', 'Store'),
]

# name, kind, cycle start, ship date, shipped?, [(component, version)]
REAL_RELEASES = [
    ('DAI Android 33.0.0', 'component', date(2026, 7, 6),
     date(2026, 7, 8), True,
     [('dai_android', '33.0.0'), ('dai_ios', '33.0.0')]),
    ('Hotfix 6 JUL 2026', 'hotfix', date(2026, 7, 6),
     date(2026, 7, 9), True,
     [('b', '32.0.5'), ('dai', '30.0.3'), ('drc_android', '29.0.0'), ('drc_ios', '29.0.0'), ('f', '31.0.6'), ('g', '6.4.7'), ('store', '13.1.2')]),
    ('DAI Android 34.0.0', 'component', date(2026, 7, 9),
     date(2026, 7, 10), True,
     [('dai_android', '34.0.0'), ('dai_ios', '34.0.0')]),
    ('Release 29 JUN 2026', 'standard', date(2026, 6, 9),
     date(2026, 7, 13), True,
     [('a', '24.0.0'), ('b', '33.0.0'), ('courier_base', '7.6.0'), ('dai_android', '34.1.0'), ('dai_ios', '34.1.0'), ('dai', '31.0.0'), ('drc_android', '30.0.0'), ('drc_ios', '30.0.0'), ('f', '32.0.0'), ('g', '7.0.0'), ('lopp_android', '13.0.0'), ('lopp_ios', '13.0.0'), ('notification', '4.0.0'), ('storage', '4.4.0'), ('store', '14.0.0')]),
    ('Accounting 7.0.0', 'component', date(2026, 6, 14),
     date(2026, 7, 13), True,
     [('accounting', '7.0.0')]),
    ('B-33.0.2', 'component', date(2026, 7, 14),
     date(2026, 7, 14), True,
     [('b', '33.0.2'), ('drc_android', '31.0.0'), ('drc_ios', '31.0.0')]),
    ('Hotfix 20 JUL 2026', 'hotfix', date(2026, 7, 17),
     date(2026, 7, 21), True,
     [('b', '33.0.4'), ('dai', '31.0.1'), ('drc_android', '32.0.0'), ('drc_ios', '32.0.0'), ('f', '32.0.2'), ('g', '7.0.1'), ('stats', '1.0.1'), ('store', '14.0.1')]),
    ('F-32.0.3', 'component', date(2026, 7, 24),
     date(2026, 7, 24), False,
     [('f', '32.0.3')]),
    ('Accounting 7.0.2', 'component', date(2026, 7, 26),
     date(2026, 7, 27), True,
     [('accounting', '7.0.2'), ('b', '33.0.6')]),
    ('Hotfix 28 JUL 2026', 'hotfix', date(2026, 7, 28),
     date(2026, 7, 28), True,
     [('a', '24.0.1'), ('dai', '31.0.2'), ('f', '32.0.4'), ('store', '14.0.4')]),
    ('Release 5 AUG 2026', 'standard', date(2026, 7, 14),
     date(2026, 8, 18), True,
     [('a', '25.0.0'), ('b', '34.0.0'), ('courier_base', '7.7.0'), ('dai_android', '35.0.0'), ('dai_ios', '35.0.0'), ('dai', '32.0.0'), ('drc_android', '33.0.0'), ('drc_ios', '33.0.0'), ('g', '7.1.0'), ('lopp_android', '13.1.0'), ('lopp_ios', '13.1.0'), ('storage', '4.5.0'), ('stats', '1.1.0'), ('store', '15.0.0')]),
    ('F-33.0.0', 'component', date(2026, 7, 13),
     date(2026, 8, 18), True,
     [('f', '33.0.0')]),
    ('Store 15.0.1', 'component', date(2026, 8, 19),
     date(2026, 8, 19), True,
     [('store', '15.0.1')]),
    ('Release 24 AUG 2026', 'standard', date(2026, 8, 19),
     date(2026, 8, 24), False,
     [('a', '25.1.0'), ('courier_base', '7.8.0'), ('dai_android', '35.1.0'), ('dai_ios', '35.1.0'), ('dai', '32.1.0')]),
]


def _releases(conn, rng, people, project_rows, made, now) -> None:
    """Fourteen real release windows, with what each one shipped.

    Read from Jira read-only and kept as they are — names, dates, artifact
    groupings. The umbrella-and-artifacts structure is not a convention we
    invented for the demo; it is what their versions already say when you group
    them by the window they ship in.
    """
    lead = Actor(id=people[-1]["id"], kind="human")
    shift = timedelta(days=(now.date() - CAPTURED_ON).days)

    comps = {}
    for key, name in REAL_COMPONENTS:
        comps[key] = int(conn.execute(components.insert().values(
            key=key, name=name,
            repo=f"drcarmen/{key.replace('_', '-')}").returning(
                components.c.id)).scalar_one())

    # An issue may be on one release *of each kind*, so each kind walks the
    # whole issue list independently and every release gets real scope. Sharing
    # one pool left the later releases empty, and an empty release is the one
    # case a timeline cannot teach you anything from.
    per_kind: dict[str, int] = {}

    for name, kind, started, ships, shipped, artifacts in REAL_RELEASES:
        cycle_start = datetime.combine(started, datetime.min.time(),
                                       tzinfo=timezone.utc) + shift
        planned = datetime.combine(ships, datetime.min.time(),
                                   tzinfo=timezone.utc) + shift
        release = rel.create(
            conn, lead, name=name, kind=kind, planned_at=planned,
            cycle_start=cycle_start,
            description=f"{name} — {len(artifacts)} artifact"
                        f"{'' if len(artifacts) == 1 else 's'}.")

        for key, version in artifacts:
            rel.add_artifact(conn, lead, release["id"], comps[key], version)

        # Bigger releases carry more work, which is the whole reason a bar's
        # scope number is worth showing.
        want = min(2 + len(artifacts), 9)
        at = per_kind.get(kind, 0)
        chunk = made[at:at + want]
        per_kind[kind] = (at + want) % max(len(made) - want, 1)
        if chunk:
            try:
                rel.add_issues(conn, lead, release["id"], [c["id"] for c in chunk])
            except TrackerError:
                pass

        for title in ("Freeze the branch", "Run the regression pass",
                      "Tag and build", "Deploy to staging",
                      "Publish release notes"):
            action = rel.add_action(conn, lead, release["id"], title)
            if shipped or rng.random() < 0.4:
                rel.complete_action(conn, lead, action["id"])

        if shipped:
            detail = rel.detail(conn, release["id"])
            for artifact in detail["artifacts"]:
                rel.ship_artifact(conn, lead, artifact["id"])
            # Shipping stamps now(); a release that went out last month should
            # say so. Mobile lands a day or two behind, as it does.
            conn.execute(text("""
                UPDATE release_artifacts SET shipped_at = :at + (
                    CASE WHEN component_id = ANY(:mobile) THEN interval '2 days'
                         ELSE interval '0' END)
                 WHERE release_id = :id AND shipped_at IS NOT NULL
            """), {"at": planned,
                   "mobile": [comps[k] for k in comps if "android" in k or "ios" in k],
                   "id": release["id"]})
            conn.execute(text("UPDATE releases SET shipped_at = :at WHERE id = :id"),
                         {"at": planned, "id": release["id"]})
        elif planned < now:
            # The date has gone by and it has not shipped: in flight, not
            # still being planned. This is what the timeline draws as late.
            conn.execute(text(
                "UPDATE releases SET state = 'in_progress' WHERE id = :id"),
                {"id": release["id"]})

        conn.execute(text(
            "UPDATE release_actions SET done_at = :at "
            " WHERE release_id = :id AND done_at IS NOT NULL"),
            {"at": planned - timedelta(days=1), "id": release["id"]})
        conn.execute(text("UPDATE releases SET notes = :n WHERE id = :i"),
                     {"n": rel.draft_notes(conn, release["id"]), "i": release["id"]})


def _automations(conn, project_rows, type_ids, status_rows) -> None:
    """Rules that would earn their keep, one of them switched off.

    The two git rules are the point of the whole integration: they are what the
    Jira we are replacing runs about 950 times a quarter, and without them
    seeded, opening a pull request in the demo does nothing anybody can see —
    the mechanism works and the screen says nothing, which is the worst way to
    show a feature.
    """
    conn.execute(automation_rules.insert().values([
        {
            "name": "A pull request moves it to In Review",
            "description": "793 of DRC's status changes last quarter were this.",
            "enabled": True,
            "trigger": {"type": "pr_opened"},
            "conditions": {"all": [
                {"field": "project_id", "op": "eq", "value": project_rows["CD"]["id"]},
            ]},
            "actions": [{"type": "transition",
                         "status_id": status_rows["in_review"]["id"]}],
        },
        {
            "name": "A merge moves it to Done",
            "description": "158 of them were this one.",
            "enabled": True,
            "trigger": {"type": "pr_merged"},
            "conditions": {"all": [
                {"field": "project_id", "op": "eq", "value": project_rows["CD"]["id"]},
            ]},
            "actions": [{"type": "transition",
                         "status_id": status_rows["done"]["id"]}],
        },
        {
            "name": "A failing build says so on the issue",
            "description": "So a red build is visible without opening GitHub.",
            "enabled": True,
            "trigger": {"type": "build_failed"},
            "conditions": {},
            "actions": [{"type": "comment",
                         "body": "The build failed on {{issue.key}}."}],
        },
        {
            "name": "Manual testing task on every release",
            "description": "The rule the whole automation design was built around.",
            "enabled": True,
            "trigger": {"type": "release_created"},
            "conditions": {},
            "actions": [{
                "type": "create_issue",
                "project_id": project_rows["QAB"]["id"],
                "issue_type_id": type_ids["task"],
                # hours_stats.classify parses "manual testing" out of QA
                # summaries to bucket hours. Do not tidy this wording.
                "summary": "Manual Testing for [{{release.name}}]",
                "description": "Covers {{release.issues}} issues on {{release.name}}.",
                "link_to_release": True,
            }],
        },
        {
            "name": "Flag highest-priority live bugs",
            "description": "Comments so the channel notices. Off until we agree the wording.",
            "enabled": False,
            "trigger": {"type": "issue_created"},
            "conditions": {"all": [
                {"field": "priority", "op": "eq", "value": "highest"},
                {"field": "project_id", "op": "eq", "value": project_rows["CD"]["id"]},
            ]},
            "actions": [{"type": "comment",
                         "body": "Highest priority on {{issue.key}} — needs an owner today."}],
        },
    ]))
