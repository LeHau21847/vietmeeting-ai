@echo off
title VietMeeting AI - Unified Launcher
color 0B

echo ===============================================================================
echo                VIETMEETING AI - HE THONG TRO LY CUOC HOP AI
echo            KHOI DONG HE THONG HOP NHAT (WEB + BACKEND + PUBLIC TUNNEL)
echo ===============================================================================
echo.

:: 1. Chuyen vao thu muc goc
cd /d "e:\PTUD"

:: 2. Kiem tra moi truong Python
if not exist "e:\PTUD\venv\Scripts\python.exe" (
    echo [ERROR] Khong tim thay Python tai e:\PTUD\venv\Scripts\python.exe
    pause
    exit /b 1
)

:: 3. Giai phong tien trinh cu tren cong 8000 neu bi ket
echo [*] Kiem tra va giai phong cong 8000 neu dang bi chiem dung...
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr :8000 ^| findstr LISTENING 2^>nul') do (
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul

:: 4. Khoi chay VietMeeting Server hop nhat (FastAPI + Web Static tren cong 8000)
echo [*] Dang khoi dong VietMeeting Server tai http://0.0.0.0:8000 ...
start "VietMeeting_Server_8000" cmd /k "cd /d e:\PTUD && e:\PTUD\venv\Scripts\python.exe -m uvicorn main:app --host 0.0.0.0 --port 8000"

:: 5. Vong lap Healthcheck: Cho Server san sang 100% truoc khi lam buoc tiep theo
echo [*] Dang cho Server khoi dong hoan tat va san sang (Healthcheck)...
:HEALTH_LOOP
e:\PTUD\venv\Scripts\python.exe -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2)" >nul 2>&1
if "%ERRORLEVEL%"=="0" goto SERVER_READY
timeout /t 1 /nobreak >nul
goto HEALTH_LOOP

:SERVER_READY
echo [OK] VietMeeting Server da SAN SANG tai http://127.0.0.1:8000

:: 6. Xoa file public_url.txt cu neu co
if exist "e:\PTUD\public_url.txt" del /f /q "e:\PTUD\public_url.txt" >nul 2>&1

:: 7. Khoi dong Cloudflare Public HTTPS Tunnel
echo [*] Dang khoi tao Duong ham Cong khai (Cloudflare Public HTTPS Tunnel)...
start "VietMeeting_Public_Tunnel" cmd /c "cd /d e:\PTUD && e:\PTUD\venv\Scripts\python.exe start_public_tunnel.py"

:: 8. Cho file public_url.txt duoc tao (toi da 12 giay)
set TUNNEL_COUNT=0
:WAIT_TUNNEL
if exist "e:\PTUD\public_url.txt" goto TUNNEL_READY
timeout /t 1 /nobreak >nul
set /a TUNNEL_COUNT+=1
if %TUNNEL_COUNT% geq 12 goto TUNNEL_TIMEOUT
goto WAIT_TUNNEL

:TUNNEL_READY
set /p PUBLIC_URL=<"e:\PTUD\public_url.txt"
goto GET_LAN_IP

:TUNNEL_TIMEOUT
set PUBLIC_URL=Dang khoi tao tunnel... (Vui long xem cua so VietMeeting_Public_Tunnel)

:GET_LAN_IP
:: 9. Tu dong tim dia chi IP mang LAN
set LAN_IP=127.0.0.1
for /f "delims=" %%i in ('e:\PTUD\venv\Scripts\python.exe -c "import socket; s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(('8.8.8.8', 80)); print(s.getsockname()[0]); s.close()" 2^>nul') do set LAN_IP=%%i

:: 10. In bang thong tin dieu hanh
echo.
echo ===============================================================================
echo                VIETMEETING AI - HE THONG TRUY CAP HOAN TAT
echo ===============================================================================
echo.
echo   [1] LOCAL WEB  : http://127.0.0.1:8000 (hoac http://localhost:8000)
echo   [2] WIFI / LAN : http://%LAN_IP%:8000
echo   [3] PUBLIC URL : %PUBLIC_URL%
echo.
echo   -----------------------------------------------------------------------------
echo   * Giao dien Web va Backend API chay chung tren 1 cong 8000 hop nhat.
echo   * Khong bao gio gap loi ket noi hay loi CORS.
echo   * Link Public [3] cho phep truy cap tu dien thoai hoac may tinh khac qua 4G/Internet.
echo ===============================================================================
echo.

:: 11. Tu dong mo trinh duyet mac dinh tai http://127.0.0.1:8000
echo [*] Dang mo trinh duyet Web tai http://127.0.0.1:8000 ...
start "" "http://127.0.0.1:8000"

echo.
echo [!] He thong dang chay on dinh. Nhan phim bat ky neu muon dong cua so dieu khien nay.
pause >nul
