"""
start_public_tunnel.py

Tu dong tao Link Cong Khai HTTPS mien phi (Public Internet Tunnel)
tro thang vao VietMeeting AI Backend + Web Server (http://127.0.0.1:8000).

Ho tro:
1. Cloudflare Quick Tunnel (chinh thuc, toc do cao, khong can tai khoan)
2. Fallback sang localhost.run qua SSH neu khong the dung Cloudflare
"""

import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
CLOUDFLARED_EXE = BASE_DIR / "cloudflared.exe"
CLOUDFLARED_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
PUBLIC_URL_FILE = BASE_DIR / "public_url.txt"
TARGET_LOCAL_PORT = 8000


def download_cloudflared() -> bool:
    """Tai cloudflared.exe tu official GitHub Release neu chua co."""
    if CLOUDFLARED_EXE.exists() and CLOUDFLARED_EXE.stat().st_size > 10_000_000:
        return True

    print("[*] Dang tai Cloudflare Tunnel (cloudflared.exe) de tao Link Public HTTPS...")
    try:
        req = urllib.request.Request(CLOUDFLARED_URL, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as response, open(CLOUDFLARED_EXE, "wb") as out_file:
            total_size = int(response.headers.get("Content-Length", 0))
            downloaded = 0
            chunk_size = 1024 * 1024  # 1MB
            while True:
                chunk = response.read(chunk_size)
                if not chunk:
                    break
                out_file.write(chunk)
                downloaded += len(chunk)
                if total_size > 0:
                    percent = int(downloaded * 100 / total_size)
                    print(f"    -> Da tai {downloaded // (1024 * 1024)}MB / {total_size // (1024 * 1024)}MB ({percent}%)...", end="\r")
        print("\n[OK] Tai cloudflared.exe thanh cong!")
        return True
    except Exception as exc:
        print(f"\n[!] Khong the tai cloudflared.exe: {exc}")
        if CLOUDFLARED_EXE.exists():
            try:
                CLOUDFLARED_EXE.unlink()
            except Exception:
                pass
        return False


def run_cloudflare_tunnel():
    """Chay Cloudflare Quick Tunnel va trich xuat URL."""
    print("[*] Khoi dong Cloudflare Quick Tunnel toi http://127.0.0.1:8000 ...")
    cmd = [
        str(CLOUDFLARED_EXE),
        "tunnel",
        "--url",
        f"http://127.0.0.1:{TARGET_LOCAL_PORT}",
        "--no-autoupdate",
    ]

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            encoding="utf-8",
            errors="replace",
        )
    except Exception as exc:
        print(f"[!] Loi khoi chay cloudflared: {exc}")
        return False

    public_url = None
    url_pattern = re.compile(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com")

    for line in proc.stdout:
        line_clean = line.strip()
        match = url_pattern.search(line_clean)
        if match and not public_url:
            public_url = match.group(0)
            with open(PUBLIC_URL_FILE, "w", encoding="utf-8") as f:
                f.write(public_url)
            print("\n" + "=" * 76)
            print("   [OK] PUBLIC HTTPS TUNNEL DA SAN SANG!")
            print(f"   >>> PUBLIC URL: {public_url}")
            print("   (Bat ky ai tren mang Internet deu co the truy cap vao duong link nay)")
            print("=" * 76 + "\n")

    proc.wait()
    return True


def run_ssh_fallback_tunnel():
    """Fallback tunnel qua SSH localhost.run neu khong co cloudflared."""
    print("[*] Dang thu ket noi tunnel fallback qua localhost.run (SSH)...")
    cmd = [
        "ssh",
        "-o", "StrictHostKeyChecking=no",
        "-R", f"80:127.0.0.1:{TARGET_LOCAL_PORT}",
        "nokey@localhost.run",
    ]
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            encoding="utf-8",
            errors="replace",
        )
        url_pattern = re.compile(r"https://[a-zA-Z0-9-]+\.lhr\.life")
        for line in proc.stdout:
            match = url_pattern.search(line)
            if match:
                url = match.group(0)
                with open(PUBLIC_URL_FILE, "w", encoding="utf-8") as f:
                    f.write(url)
                print("\n" + "=" * 76)
                print("   [OK] PUBLIC SSH TUNNEL DA SAN SANG!")
                print(f"   >>> PUBLIC URL: {url}")
                print("=" * 76 + "\n")
                break
        proc.wait()
    except Exception as exc:
        print(f"[!] Loi chay SSH fallback tunnel: {exc}")


def main():
    if download_cloudflared():
        run_cloudflare_tunnel()
    else:
        run_ssh_fallback_tunnel()


if __name__ == "__main__":
    main()

