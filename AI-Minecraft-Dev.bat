@echo off
setlocal
title AI Minecraft - Gameplay Dev

set "WSL_DISTRO=Ubuntu"
set "REPO=/home/ikdmtm/dev/ai-minecraft"
set "REMOTE=https://github.com/ikdmtm/ai-minecraft.git"
set "BRANCH=revive/gameplay-first-jev"

echo [AI Minecraft] Starting WSL2 gameplay environment...

wsl.exe -d "%WSL_DISTRO%" -- bash -lc "set -e; if [ ! -d '%REPO%/.git' ]; then mkdir -p /home/ikdmtm/dev; git clone --branch '%BRANCH%' --single-branch '%REMOTE%' '%REPO%'; fi; cd '%REPO%'; exec bash scripts/dev-one-touch.sh start"

set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo [AI Minecraft] Launcher exited with code %RC%.
  echo Check the message above. This window will stay open.
  pause
)

endlocal
