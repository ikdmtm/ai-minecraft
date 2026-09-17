@echo off
setlocal
title AI Minecraft - Fresh Fixed-Seed Test

set "WSL_DISTRO=Ubuntu"
set "REPO=/home/ikdmtm/dev/ai-minecraft"
set "REMOTE=https://github.com/ikdmtm/ai-minecraft.git"
set "BRANCH=revive/gameplay-first-jev"
set "TEST_SEED=8675309"

echo [AI Minecraft] Updating code, resetting the Hardcore world, and starting AI_Rei...
echo [AI Minecraft] Fixed test seed: %TEST_SEED%

wsl.exe -d "%WSL_DISTRO%" -- bash -lc "set -e; if [ ! -d '%REPO%/.git' ]; then mkdir -p /home/ikdmtm/dev; git clone --branch '%BRANCH%' --single-branch '%REMOTE%' '%REPO%'; fi; cd '%REPO%'; exec bash scripts/dev-one-touch.sh reset '%TEST_SEED%'"

set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo [AI Minecraft] Launcher exited with code %RC%.
  echo Check the message above. This window will stay open.
  pause
)

endlocal
