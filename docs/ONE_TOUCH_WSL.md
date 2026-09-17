# One-touch gameplay launcher (WSL2)

WSL2 Ubuntu is the canonical development/runtime environment. Windows is only an optional launcher surface.

## Normal use from WSL2

From `/home/ikdmtm/dev/ai-minecraft`:

```bash
bash run.sh
```

The launcher automatically:

1. checks/install missing Ubuntu prerequisites when necessary
2. fetches `revive/gameplay-first-jev` from GitHub
3. switches/pulls the branch with fast-forward only
4. temporarily stashes and restores local source changes if necessary
5. runs `npm ci` only when dependencies are missing or `package-lock.json` changed
6. creates `.env` if missing and asks for `ANTHROPIC_API_KEY` only when needed
7. sets up the local Minecraft server if missing
8. starts the Minecraft server if it is not already running
9. starts the gameplay-only AI runtime

The Minecraft server remains in WSL2 under `.minecraft-dev/server/`.

## Fresh reproducible test

Reset the Hardcore world to the standard fixed test seed and launch:

```bash
bash run.sh reset 8675309
```

Use this after gameplay changes when comparing before/after behavior.

## Windows double-click option

`AI-Minecraft-Dev.bat` and `AI-Minecraft-Fresh-Test.bat` are optional convenience launchers. They do not run the stack natively on Windows: they only invoke Ubuntu through `wsl.exe`. Git, Node.js, Minecraft server, Mineflayer, SQLite, and the AI runtime all remain inside WSL2.

## First checkout only

If the local repository predates the revival branch, run once:

```bash
cd /home/ikdmtm/dev/ai-minecraft
git fetch origin
git switch revive/gameplay-first-jev || git switch -c revive/gameplay-first-jev --track origin/revive/gameplay-first-jev
git pull --ff-only origin revive/gameplay-first-jev
```

After that, `bash run.sh` handles updates automatically.
