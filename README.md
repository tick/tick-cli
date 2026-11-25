# Tick CLI

Use `tick` to review a timesheet, find a client or task, check a budget, record time, manage a timer, or administer a subscription. Each operation has a terminal command and a JSON interface for agents. The client talks directly to the [Tick API v2](https://github.com/tick/tick-api).

## Install

With Node.js 22 or later and npm installed, run:

```sh
npm install --global https://github.com/tick/tick-cli/archive/refs/heads/main.tar.gz
```

Run `tick --version` to check the installation. Repeat the install command to update to the latest code on `main`. From a source checkout, you can also run `node bin/tick.js` directly. The CLI has no runtime package dependencies.

## Connect a Tick account

```console
$ tick login
You are now logged into the Harbor Studio account as lee@example.test.
```

Use `tick login --json` for machine-readable output.

Browser login requires a Tick server with the OAuth provider deployed. On an older server, use the existing API token login described below.

Tick opens your browser. Choose the subscription you want to connect. If you already have a Tick session in that browser, you can use it. To log time or change timers, run `tick login --allow-writes` and approve the additional permission. If you own or administer the selected subscription, you can create and edit users, clients, projects, and tasks as soon as you sign in. Tick checks your current role on each request.

If the browser does not open, follow the URL printed in the terminal. Use `tick login --no-browser` to skip the automatic launch. Open the link on the same computer as the CLI. Over SSH, forward the loopback port shown in the link’s `redirect_uri` to the same port on the remote host.

The CLI saves the selected account and its credentials in `$XDG_CONFIG_HOME/tick/account.json` or `~/.config/tick/account.json` with owner-only permissions. It renews browser credentials automatically. Signing in again revokes the previous saved browser connection before switching to the new account or permissions. When switching API origins, log out at the previous origin first. Run `tick logout` to revoke the saved browser connection and clear its credentials. If Tick cannot confirm revocation, the CLI keeps the file so you can retry.

To sign in with an existing API token, run:

```sh
tick login --subscription-id 123
```

The prompt hides your token. Scripts can pipe it with `--token-stdin`. The existing `tick login --email EMAIL` command also supports a hidden password prompt or `--password-stdin`; use `--subscription-id ID` to select among multiple accounts. Logging out of a legacy account removes the local file. Keep passwords and tokens out of command arguments.

For a script, supply `TICK_SUBSCRIPTION_ID` and `TICK_API_TOKEN` together. They override the saved account. Tick identifies the token owner directly, even when their timesheet is empty. Set `TICK_USER_ID` if the script should stop when the token belongs to another user. On a server without the current-user endpoint, use browser or email login if Tick cannot identify the token owner.

## First commands

To record time in a terminal, sign in with write access, then run `tick log 45m`. Choose a recent task by number or type a task name to search. Each choice shows its client, project and task. Press Enter at the prompt to cancel. For scripts and JSON output, pass `--task-id` explicitly.

```sh
tick tasks recent
tick tasks search design --project-id 16
tick week
tick projects budget 16
tick log 45m --task-id 24 --notes "Reviewed the design" --dry-run
tick log 45m --task-id 24 --notes "Reviewed the design"
```

Check the project and task IDs before posting, especially when names repeat. A time entry accepts a positive duration of up to 24 hours, such as `45m`, `1h30m`, or `1.5`. Pass `--date YYYY-MM-DD` to record time for another day. Tick supplies today’s date when you omit it.

| Command | Purpose |
| --- | --- |
| `tick account`, `tick users list` | See the selected account and people visible to your role. |
| `tick clients list`, `tick clients get ID` | Find open, closed or all clients and inspect project summaries. |
| `tick projects list`, `tick projects get ID`, `tick projects budget ID` | Browse projects, get details and check remaining budget. |
| `tick tasks list`, `tick tasks get ID`, `tick tasks recent`, `tick tasks search QUERY`, `tick tasks budget ID` | Find a task and inspect its budget. |
| `tick week`, `tick entries list`, `tick entries get ID` | Review your current week or filter entries visible to your role. |
| `tick report --start-date DATE --end-date DATE` | Total recorded hours across all pages, grouped by day, task, or user. |
| `tick log DURATION --task-id ID`, `tick entries update ID` | Record time or edit your own unbilled entry. |
| `tick timers list`, `tick timers get ID`, `tick timers start [TASK_ID]`, `tick timers update ID` | Inspect timers, start a new timer, or change its task and notes. |
| `tick timers pause ID`, `tick timers resume ID`, `tick timers save ID` | Pause, resume or turn a timer into a time entry. |

Use `--help` after a command for its arguments. Write commands accept `--dry-run` to preview the method, path and payload. A `tick log` preview with an explicit `--task-id` runs offline. Choosing a task interactively reads your task list from Tick. The preview omits fields supplied by Tick or resolved during the live request, such as the logged-in user’s ID. The CLI never automatically retries writes. If the connection drops while recording time, check the timesheet before repeating the command.

### Manage a subscription

```sh
tick users create --first-name Jo --last-name Park --email jo@example.com --dry-run
tick users update 8 --billable-rate 85.50
tick clients create --name "Acme"
tick clients update 3 --name "Acme Studio"
tick projects add --client Acme --owner me --name "Launch" --budget 40
tick projects update 16 --billable false
tick tasks add --project Launch --client Acme --name "Design"
tick tasks update 24 --budget 12
```

Management commands match client and project names exactly, ignoring case, including closed records. Use `--owner me`, a full name, or an email address for the project owner. You can also use numeric IDs with `--client-id`, `--owner-id`, and `--project-id`. Supply one selector per resource. If several projects share a name, add `--client` or `--client-id`. If several owners share a name, use their email or ID. A missing or ambiguous match stops the command before it writes.

To rename a client, run `tick clients edit --client Acme --name "Acme Studio"`. To rename a project, run `tick projects edit --project Launch --client Acme --name Website`. Here the client identifies the project. To move the project, use its ID as the target, for example `tick projects edit 16 --client "Acme Studio"`. Named dry runs read from Tick and show the resolved IDs. Management previews with IDs alone run offline. JSON tools accept the same selectors as `client`, `owner`, and `project`.

In terminal commands for users, clients, projects, and tasks, `add` is an alias for `create`, and `edit` is an alias for `update`.

Creating a user sends an email invitation. Inviting someone who already uses Tick preserves their existing profile. Administrators can change a member's role and hourly rate for the selected subscription. They can also change the first name, last name and time zone of a person who belongs only to that subscription. Login email and password changes belong to the user. The subscription owner keeps the administrator role.

Creating a project assigns all users in the subscription. Use `--help` on any create or update command to see its supported fields. Updates send only the fields you supply.

### Reports and budgets

```sh
tick entries list --start-date 2026-11-01 --end-date 2026-11-30 --billable true --page 1 --json
tick report --start-date 2026-11-01 --end-date 2026-11-30 --group-by task
tick projects list --include-budget true --json
tick tasks list --project-id 16 --state closed --include-budget true
```

`week` sums the current user’s recorded entries Monday through Sunday in the subscription’s time zone. `entries list` accepts an inclusive date range or `--updated-at` with an ISO timestamp and timezone. Administrators can see other users’ entries in date-range queries. Add `--user-id` to select one person. `report` sums up to 5,000 matching entries. If more match, it asks for a smaller range before reporting a total.

Project and task budgets count all recorded entries across people and dates. Running timers count once saved. A negative balance means over budget; a null balance means no budget was set. Collection pages contain up to 100 records. Pass `--page 2`, then higher numbers, until Tick returns an empty list. Task search reads at most five pages per call and returns `next_page` when more may be available.

### Timers

```sh
tick timers start --notes "Design review"
tick timers list
tick timers pause 7
tick timers resume 7
tick timers update 7 --task-id 24
tick timers save 7
```

Use `tick timers start` to start tracking before you choose a task, or `tick timers start 24` to start on task 24. `tick timers list` shows all your running and paused timers in the selected account, including those without a task. Assign a task before saving a timer as a time entry.

When you assign a task or resume a timer with a task, the task and project must be open and the project must be assigned to you. An administrator who can see additional projects must still be assigned to the selected project. You can retarget a timer whose previous project has closed.

Use the timer ID returned from `start` for the remaining commands. Starting or resuming a timer pauses the other running timer in that subscription. Pausing keeps the elapsed time. Saving creates an entry dated today in the user’s timezone and removes the timer. Tick's timer response reports accumulated seconds from previous runs and the start of the current run in `last_started_at`.

Timer saves from CLI and MCP processes that share the same OS home directory use one local lock per subscription and timer. If Tick's response is lost or a process stops during conversion, later saves return the lock directory. Before removing this directory, verify that the original process has finished and check both the timer and timesheet in Tick. If the entry already exists, leave it as recorded. If the timer is still present and no entry was recorded, remove only the reported empty directory with `rmdir` and save the timer. Separate devices and OS users cannot share this protection; atomic cross-device conversion requires support from Tick’s API.

## Scripts and AI assistants

```sh
tick tools --json
printf '%s\n' '{"project_id":16}' | tick call get_project_budget --json
printf '%s\n' '{"task_id":24,"duration":"45m","notes":"Planning"}' | tick call log_time --json --dry-run
```

`tools --json` returns the catalog, descriptions, JSON input schemas and tool annotations. `call` accepts exactly one JSON object on stdin. Every operation runs the same validation and Tick API calls as its terminal equivalent. `--json` writes a bare JSON value to stdout on success. On failure, stderr contains `{"error":{"code":"…","message":"…"}}` and the process exits with status 1 for service/configuration errors or 2 for invalid input. Rate-limit errors include `status` and `retry_after` when supplied by Tick.

`tick session --json` returns an opaque local account binding. An integration can pass it in `TICK_EXPECTED_SESSION` on subsequent calls. Browser credentials keep the same binding through automatic renewal. A new browser login, changed legacy token, account switch, or removed profile returns `session_changed` before any Tick API request. Restart the integration to select the current account.

To connect an MCP-compatible assistant, add `https://www.tickspot.com/mcp` as a remote server and authorize the assistant in your browser. Tick hosts the server. You can use it without installing the CLI. The CLI also includes a portable [Tick skill](skills/tick/SKILL.md).

## Development

```sh
npm test
```

Tests run the CLI as a child process against a local fixture. Set `TICK_BASE_URL` for a separate development API origin. HTTPS is required except on loopback, and the client rejects redirects. Production defaults to `https://www.tickspot.com`.
