# Joining

> **Status:** built and running, 2026-08-22.
>
> `backend/app/auth_store.py` holds the invitations, `main.py` has the routes,
> `backend/app/nox/identity.py` does the claim, `JoinPage.tsx` is the screen and
> the composer lives on the Accounts page.

---

## 1. Nobody is handed a password

The obvious way to get a team onto a new tracker is for an admin to create
everybody's account and tell them their password. Do that and one person knows
every password in the company and has said them out loud, in a chat window or
across a desk.

So an admin says **who may join**, and the person chooses their own secret:

1. Accounts → *Invite somebody*. Email, role, and optionally *who they already
   are* in the tracker.
2. **Make a link** — it lands on the clipboard.
3. Send it however you like.
4. They open it, pick a username and a password, and are **signed in**.

No approval queue afterwards. Writing the invitation *is* the approval, and
asking an admin to say it twice is a queue for no reason. Self-registration
still exists for anybody who arrives without a link; that one still waits.

A link works **once** and expires after fourteen days — an invitation nobody
acted on in a fortnight is one somebody forgot to send. The reasons it can fail
are separate sentences on purpose: *not one of ours*, *already used*, *expired*.
"Invalid" tells the person holding it nothing they can act on; the other three
each say exactly what to go back and ask for.

---

## 2. Claiming a person

The tracker was populated before anybody could sign in. Seventeen people own
sixty-six issues, fifty-four comments and eight hundred and forty-five events,
and not one of them has an account.

So when the real Ana joins, she would be a *new* person, and the Ana who wrote
all that history would be a ghost with her name.

An invitation can therefore say **you are this person**. The composer offers the
seeded people with their issue counts, so it is a pick from a list rather than
an id somebody has to look up, and the join screen says it back in the second
person and by name — *"You will pick up where Ana Mihalache left off."* Somebody
deciding whether a link is really for them is answered by a name, never by
`900016`.

Accepting moves everything across and retires the ghost.

### The columns are discovered, never listed

Accounts live in SQLite and the tracker in Postgres, so **there is not one
foreign key from any of this to `users`** — twenty-six columns hold a user id
and none of them declares it.

A hand-written list would be wrong the first time somebody adds
`issues.closed_by`, and wrong *silently*: the merge would report success and
leave a row pointing at an id that no longer exists. So the list is read from
`information_schema` every time the claim runs.

Two things a sweep cannot find, handled by name:

- **`project_access.value`** is a *text* column that holds a user id when `kind`
  is `'user'`. Missing it would quietly take away somebody's access to a project
  on the day they joined.
- **`notification_prefs.user_id`** and **`team_members (team_id, user_id)`** are
  primary keys, so if both the account and the person have a row, repointing one
  onto the other violates the key. The account's own row wins — it is the one
  that person has actually been using.

### Nothing is deleted until nothing points at it

After the moves, the claim counts every reference to the old person again. If
any remain it raises, which rolls the whole transaction back — so "nothing has
been changed" is true rather than hopeful. Only a clean count deletes the ghost.

### The name has to go on the account

`api.py:_project_user` copies `display_name` from the account into the tracker
**on every request**. A name written straight into the tracker's copy is
overwritten by the first thing that person clicks, so they arrive as `ana`
owning eight issues that all say Ana Mihalache. The claim sets it on the
account, where it survives.

Found by doing it: the first test produced exactly that.

---

## 3. Getting to it

The compose file binds `0.0.0.0:8090`, so anybody on the same network can reach
Nox at `http://<this-machine>:8090` and an invitation link will work for them.
Off the network, nobody can — that needs a deployment, and the going-live
section of [RUNNING.md](RUNNING.md) is still written for when Nox lived inside
another app.

---

## 4. Decisions

| Decision | Why |
|---|---|
| Invite, never create-with-a-password | Otherwise one person knows everybody's password and has said it out loud |
| Approved on arrival | The admin already decided when they wrote the invitation |
| One use, fourteen days | A link that outlives its purpose is a way in that nobody is watching |
| Three refusal sentences, not "invalid" | The person holding the link has to know what to ask for |
| Columns discovered from `information_schema` | There are no foreign keys to lean on, and a missed column fails silently |
| Roll back unless the old person is unreferenced | With no foreign keys, a dangling id surfaces months later as a blank name |
| Used invitations are kept | Who invited whom is worth knowing; revoked ones are deleted, because a revoked link that lingers invites a second look at whether it still works |
