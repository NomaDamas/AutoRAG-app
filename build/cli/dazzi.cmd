@echo off
rem DAZZI-CLI-LAUNCHER (Windows): the `dazzi` command, shipped next to the app at resources\bin\dazzi.cmd.
rem
rem   dazzi [path...]    open folders (and show files in their folder) in Dazzi
rem   dazzi              bring Dazzi to the front
rem
rem It builds the request the Explorer menu already sends (--autorag-request=open plus one --autorag-path= per
rem item) and starts the app's own executable with it; a running Dazzi takes the request over and this exits.
rem DAZZI_USER_DATA_DIR aims the request at another profile (development, QA).
setlocal EnableExtensions DisableDelayedExpansion

set "EXE=%~dp0..\..\Dazzi.exe"
if not exist "%EXE%" (
	echo dazzi: %EXE% not found 1>&2
	exit /b 1
)

set "ELECTRON_RUN_AS_NODE="
set "ARGS="
set "COUNT=0"
set "STATUS=0"
set "LIST=1"

:options
if "%~1"=="" goto paths
if /i "%~1"=="-h" goto help
if /i "%~1"=="--help" goto help
if "%~1"=="--" (
	shift
	goto paths
)
set "FIRST=%~1"
if "%FIRST:~0,1%"=="-" (
	echo dazzi: unknown option %~1 1>&2
	exit /b 2
)

:paths
if "%~1"=="" goto launch
if not exist "%~1" (
	echo dazzi: %~1: No such file or directory 1>&2
	set "STATUS=1"
	shift
	goto paths
)
set "P=%~f1"
rem A trailing backslash would escape the closing quote in the request; only a drive root keeps one.
if "%P:~-1%"=="\" if not "%P:~-2%"==":\" set "P=%P:~0,-1%"
set "ARGS=%ARGS% "--autorag-path=%P%""
set /a COUNT+=1
shift
goto paths

:launch
if %COUNT%==0 (
	if "%STATUS%"=="0" (
		start "" "%EXE%"
	)
	exit /b %STATUS%
)
if %COUNT% GTR 200 (
	echo dazzi: too many paths ^(the limit is 200^) 1>&2
	exit /b 1
)
set "PROFILE="
if defined DAZZI_USER_DATA_DIR set PROFILE="--user-data-dir=%DAZZI_USER_DATA_DIR%"
start "" "%EXE%" %PROFILE% --autorag-request=open%ARGS%
exit /b %STATUS%

:help
echo Usage: dazzi [--] [path...]
echo.
echo Open folders in Dazzi, or show files selected in their folder.
echo With no path, bring Dazzi to the front.
echo.
echo   -h, --help   show this help
exit /b 0
