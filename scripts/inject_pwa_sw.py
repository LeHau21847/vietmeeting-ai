"""
scripts/inject_pwa_sw.py

Tự động tạo Service Worker (sw.js) và đính kèm vào mobile/dist/index.html
để đảm bảo giao diện Web (HTML/JS/CSS/Fonts trong mobile/dist) luôn tải lên
tức thì khi người dùng nhấn F5 trình duyệt kể cả khi mất mạng (True Offline PWA Caching).
"""

from __future__ import annotations

import json
from pathlib import Path

DIST_DIR = Path(__file__).resolve().parent.parent / "mobile" / "dist"


def collect_precache_urls(dist_dir: Path) -> list[str]:
    urls: list[str] = ["/", "/index.html"]
    for file_path in sorted(dist_dir.rglob("*")):
        if not file_path.is_file():
            continue
        rel = file_path.relative_to(dist_dir).as_posix()
        if rel in ("sw.js", "index.html"):
            continue
        if rel.startswith(("_expo/", "assets/")) or rel in ("favicon.ico", "metadata.json"):
            urls.append("/" + rel)
    return urls


def build_sw_js(precache_urls: list[str]) -> str:
    urls_json = json.dumps(precache_urls, indent=2)
    return f"""// VietMeeting AI - Offline-First PWA Service Worker
const CACHE_NAME = "vietmeeting-static-v3";
const API_CACHE_NAME = "vietmeeting-api-v3";
const PRECACHE_ASSETS = {urls_json};

self.addEventListener("install", (event) => {{
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {{
      for (const url of PRECACHE_ASSETS) {{
        try {{
          await cache.add(url);
        }} catch (e) {{
          // Bỏ qua nếu 1 asset phụ chưa sẵn sàng
        }}
      }}
    }})
  );
}});

self.addEventListener("activate", (event) => {{
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== API_CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
}});

self.addEventListener("fetch", (event) => {{
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // 1. Tài nguyên tĩnh (_expo JS/CSS, assets Fonts, favicon): Cache-First
  if (
    url.pathname.startsWith("/_expo/") ||
    url.pathname.startsWith("/assets/") ||
    url.pathname === "/favicon.ico"
  ) {{
    event.respondWith(
      caches.match(req).then((cached) => {{
        if (cached) return cached;
        return fetch(req).then((networkRes) => {{
          if (networkRes && networkRes.status === 200) {{
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, clone));
          }}
          return networkRes;
        }});
      }})
    );
    return;
  }}

  // 2. Điều hướng trang (F5 / Reload HTML): Network-First, Fallback về Cache /index.html
  if (req.mode === "navigate" || url.pathname === "/" || url.pathname === "/index.html") {{
    event.respondWith(
      fetch(req)
        .then((networkRes) => {{
          if (networkRes && networkRes.status === 200) {{
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((c) => c.put("/index.html", clone));
          }}
          return networkRes;
        }})
        .catch(async () => {{
          const cachedIndex = await caches.match("/index.html");
          if (cachedIndex) return cachedIndex;
          return caches.match("/");
        }})
    );
    return;
  }}

  // 3. API GET danh sách cuộc họp & nhiệm vụ: Network-First kèm Offline Cache Fallback
  if (url.pathname.startsWith("/api/v1/meetings") || url.pathname.startsWith("/api/v1/tasks")) {{
    event.respondWith(
      fetch(req)
        .then((networkRes) => {{
          if (networkRes && networkRes.status === 200) {{
            const clone = networkRes.clone();
            caches.open(API_CACHE_NAME).then((c) => c.put(req, clone));
          }}
          return networkRes;
        }})
        .catch(() => caches.match(req))
    );
  }}
}});
"""


def main() -> None:
    if not DIST_DIR.exists():
        print(f"[WARN] Không tìm thấy {DIST_DIR}")
        return

    precache_urls = collect_precache_urls(DIST_DIR)
    sw_path = DIST_DIR / "sw.js"
    sw_path.write_text(build_sw_js(precache_urls), encoding="utf-8")
    print(f"[OK] Đã tạo {sw_path} với {len(precache_urls)} tài nguyên tĩnh được Pre-cache.")

    index_path = DIST_DIR / "index.html"
    if index_path.exists():
        html = index_path.read_text(encoding="utf-8")
        sw_script = (
            "<script>"
            "if('serviceWorker' in navigator){"
            "window.addEventListener('load',function(){"
            "navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(function(){});"
            "});"
            "}"
            "</script>"
        )
        if "navigator.serviceWorker.register('/sw.js'" not in html:
            html = html.replace("</body>", f"{sw_script}</body>")
            index_path.write_text(html, encoding="utf-8")
            print("[OK] Đã nhúng trình đăng ký Service Worker vào mobile/dist/index.html.")


if __name__ == "__main__":
    main()

