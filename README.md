# Azure Spot Restart Bot

Monitors an Azure Spot VM, reports its state to Grafana (Graphite), and auto-restarts the VM when it gets deallocated. Sends Teams alerts on recovery or failure.

## Requirements
- Node.js 18+ and npm
- Azure access with an app registration (client secret)
- Graphite endpoint (Grafana Cloud or self-hosted) for metric `azure.vm.<name>.up` (optional)
- Teams webhook URL (optional)

## Setup
1) Install dependencies
```bash
npm install
```

2) Copy the sample env file and fill your values
```bash
cp example.env .env
```
- `AZURE_*`: Azure AD app credentials + subscription/resource group/VM
- `GRAFANA_*`: Graphite URI ending with `/metrics`, user/token if required
- `TEAMS_WEBHOOK_URL`: Teams channel webhook
- `CHECK_INTERVAL_SECONDS`: check frequency (default 60)

## Run locally
```bash
node index.js
```
You should see initialization logs, then one line per cycle with the VM state. When Spot eviction occurs (`deallocated`), the bot issues a `Start` and notifies Grafana/Teams.

## Behavior
- Uses VM Instance View to read the power state each cycle.
- If `PowerState/running`: sends `1` to Graphite.
- If `PowerState/deallocated`: sends `0`, attempts Azure `Start`, then sends a Teams alert (success/failure).
- Other states (Stopped/Starting/Unknown): sends `0` to Graphite.

## Deployment / service options
- Linux service: run with `pm2 start index.js --name spot-bot --watch=false` and `pm2 save` to persist; load env via `.env` or a process file.
- Windows service: use NSSM to wrap `node index.js`, pointing to the project folder and `.env` file.
- Container: build an image, mount `.env` as a secret/volume, and run `node index.js` as the entrypoint.

## Testing notes
No automated tests. Manual checks you can run:
- Deallocate the VM and confirm the bot restarts it and reports up.
- Drop connectivity to Grafana/Teams to ensure the loop continues without crashing.

## Security notes
- Store secrets in Azure Key Vault or pipeline secrets, not in the repo.
- Scope the app registration to the minimal `Microsoft.Compute/virtualMachines/*` permissions needed.
