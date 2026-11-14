@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title Generador de Pistas - crear tramo para RBR (RallySimFans)
echo.
echo  Generador de Pistas  -^>  Richard Burns Rally (RallySimFans)
echo  ==========================================================
echo.

rem --- configuracion guardada (se crea sola la primera vez) ---
set "CFG=%~dp0..\rbr_config.txt"
if exist "%CFG%" for /f "usebackq tokens=1,* delims==" %%a in ("%CFG%") do set "%%a=%%b"

rem --- Blender 4.5 (el complemento de RBR 0.3.3 pide Blender 4.5; en 5.x falla) ---
if not defined BLENDER (
  for /d %%d in ("%ProgramFiles%\Blender Foundation\Blender 4.5*") do if exist "%%d\blender.exe" set "BLENDER=%%d\blender.exe"
)
if not defined BLENDER (
  for /d %%d in ("%~dp0..\blender-4.5*" "%USERPROFILE%\Downloads\blender-4.5*" "%USERPROFILE%\Desktop\blender-4.5*") do (
    if exist "%%d\blender.exe" set "BLENDER=%%d\blender.exe"
    for /d %%e in ("%%d\blender-4.5*") do if exist "%%e\blender.exe" set "BLENDER=%%e\blender.exe"
  )
)
if not defined BLENDER (
  echo  No encontre Blender 4.5.
  echo  Descargalo de https://download.blender.org/release/Blender4.5/  ^(blender-4.5.x-windows-x64.zip^),
  echo  descomprimilo en Descargas y volve a ejecutar este archivo.
  echo.
  set /p "BLENDER=O pega aca la ruta completa de blender.exe 4.5: "
)
if not exist "%BLENDER%" ( echo  No existe: %BLENDER% & goto :fin )

rem --- complemento RBR Track Addon ---
if not defined ADDON (
  for %%f in ("%~dp0rbr-track-exporter-v*.zip" "%~dp0..\rbr-track-exporter-v*.zip" "%USERPROFILE%\Downloads\rbr-track-exporter-v*.zip") do if exist "%%f" set "ADDON=%%~f"
)

rem --- carpeta Maps de RBR ---
if not defined RBR_MAPS (
  for %%p in ("C:\Richard Burns Rally\Maps" "C:\Games\Richard Burns Rally\Maps" "D:\Richard Burns Rally\Maps" "D:\Games\Richard Burns Rally\Maps" "C:\RBR\Maps" "%USERPROFILE%\Games\Richard Burns Rally\Maps") do if exist "%%~p" set "RBR_MAPS=%%~p"
)
if not defined RBR_MAPS (
  set /p "RBR_MAPS=Carpeta Maps de tu RBR (ej. C:\Richard Burns Rally\Maps): "
)
if not exist "%RBR_MAPS%" ( echo  No existe la carpeta Maps: %RBR_MAPS% & goto :fin )

> "%CFG%" (
  echo BLENDER=%BLENDER%
  echo RBR_MAPS=%RBR_MAPS%
  if defined ADDON echo ADDON=%ADDON%
)

echo  Blender:     %BLENDER%
echo  Complemento: %ADDON%
echo  Maps de RBR: %RBR_MAPS%
echo.
echo  Armando el tramo en Blender (puede tardar varios minutos, no cierres esta ventana)...
echo.

set "EXTRA="
if defined ADDON set "EXTRA=--addon "%ADDON%""
if not "%~1"=="" set "EXTRA=!EXTRA! --id %~1"
"%BLENDER%" --background --python "%~dp0rbr_construir.py" -- --datos "%~dp0rbr_datos.json" --maps "%RBR_MAPS%" !EXTRA!

echo.
echo  Registro completo: %~dp0rbr_registro.txt
findstr /c:"ERROR:" "%~dp0rbr_registro.txt" >nul && (echo  Hubo errores: revisa el registro.) || (echo  Listo. En RallySimFans busca el tramo en "Test stages".)
:fin
echo.
pause
