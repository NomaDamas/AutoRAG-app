# Windows QA runner

`.github/workflows/qa-windows.yml` runs on a self-hosted GitHub Actions runner
(labels `self-hosted, Windows, X64, autorag-qa`) because GitHub-hosted Windows
minutes are not available. The runner is a Windows 11 PC that is also reachable
over SSH for maintenance.

## Why no SSH secret

The runner agent only makes outbound HTTPS connections to GitHub and pulls jobs.
Workflows never SSH into the PC, so no host, user, or key is stored in GitHub
secrets or in the repository. The SSH endpoint stays a maintainer-only door.
Only jobs that name the `autorag-qa` label can execute on the PC.

## Safety rules

- The repository is private. Keep it that way, or restrict fork-PR workflows
  (Settings → Actions → General). The workflow also skips pull requests whose
  head repository is not this repository.
- Never add `pull_request_target`, or any untrusted-input trigger, to a job that
  uses `runs-on: [self-hosted, ...]`.
- The job runs as the PC's regular user, not as a service account with
  privileges. Do not store tokens in the runner's environment.
- `permissions: contents: read` and `persist-credentials: false` keep the job's
  `GITHUB_TOKEN` minimal.

## Host prerequisites

Installed on the PC: git, Bun, Node (the workflow installs Node 24 per run),
Rust + `dupey` (`cargo install dupey --locked`), and `ffmpeg` on `PATH`.

## Runner layout

- Install dir: `D:\actions-runner`, runner name `win-ssh-pc`.
- Started by the scheduled task `AutoRAG-GH-Runner` (at startup and at logon,
  restarted on failure).

### Re-register

```powershell
# token from: gh api -X POST repos/NomaDamas/AutoRAG-app/actions/runners/registration-token --jq .token
cd D:\actions-runner
.\config.cmd --unattended --url https://github.com/NomaDamas/AutoRAG-app `
  --token <TOKEN> --name win-ssh-pc --labels autorag-qa --work _work --replace
Start-ScheduledTask -TaskName AutoRAG-GH-Runner
```

### Remove

```powershell
Stop-ScheduledTask AutoRAG-GH-Runner; Unregister-ScheduledTask AutoRAG-GH-Runner -Confirm:$false
cd D:\actions-runner; .\config.cmd remove --token <REMOVE_TOKEN>
```
