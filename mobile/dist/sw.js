// VietMeeting AI - Offline-First PWA Service Worker
const CACHE_NAME = "vietmeeting-static-v3";
const API_CACHE_NAME = "vietmeeting-api-v3";
const PRECACHE_ASSETS = [
  "/",
  "/index.html",
  "/_expo/static/css/web-114d64cc39097155544ee87abf74494c.css",
  "/_expo/static/js/web/AppEntry-3667bcac5790e376719d61002d050419.js",
  "/assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/AntDesign.3a2ba31570920eeb9b1d217cabe58315.ttf",
  "/assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Entypo.31b5ffea3daddc69dd01a1f3d6cf63c5.ttf",
  "/assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/EvilIcons.140c53a7643ea949007aa9a282153849.ttf",
  "/assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Feather.a76d309774d33d9856f650bed4292a23.ttf",
  "/assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/FontAwesome.b06871f281fee6b241d60582ae9369b9.ttf",
  "/assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/FontAwesome5_Brands.3b89dd103490708d19a95adcae52210e.ttf",
  "/assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/FontAwesome5_Regular.1f77739ca9ff2188b539c36f30ffa2be.ttf",
  "/assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/FontAwesome5_Solid.605ed7926cf39a2ad5ec2d1f9d391d3d.ttf",
  "/assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/FontAwesome6_Brands.56c8d80832e37783f12c05db7c8849e2.ttf",
  "/assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/FontAwesome6_Regular.370dd5af19f8364907b6e2c41f45dbbf.ttf",
  "/assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/FontAwesome6_Solid.adec7d6f310bc577f05e8fe06a5daccf.ttf",
  "/assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Fontisto.b49ae8ab2dbccb02c4d11caaacf09eab.ttf",
  "/assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Foundation.e20945d7c929279ef7a6f1db184a4470.ttf",
  "/assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.6148e7019854f3bde85b633cb88f3c25.ttf",
  "/assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/MaterialCommunityIcons.b62641afc9ab487008e996a5c5865e56.ttf",
  "/assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/MaterialIcons.4e85bc9ebe07e0340c9c4fc2f6c38908.ttf",
  "/assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Octicons.f7c53c47a66934504fcbc7cc164895a7.ttf",
  "/assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/SimpleLineIcons.d2285965fe34b05465047401b8595dd0.ttf",
  "/assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Zocial.1681f34aaca71b8dfb70756bca331eb2.ttf",
  "/assets/node_modules/@react-navigation/elements/lib/module/assets/back-icon-mask.0a328cd9c1afd0afe8e3b1ec5165b1b4.png",
  "/assets/node_modules/@react-navigation/elements/lib/module/assets/back-icon.35ba0eaec5a4f5ed12ca16fabeae451d.png",
  "/assets/node_modules/@react-navigation/elements/lib/module/assets/clear-icon.c94f6478e7ae0cdd9f15de1fcb9e5e55.png",
  "/assets/node_modules/@react-navigation/elements/lib/module/assets/clear-icon.c94f6478e7ae0cdd9f15de1fcb9e5e55@2x.png",
  "/assets/node_modules/@react-navigation/elements/lib/module/assets/clear-icon.c94f6478e7ae0cdd9f15de1fcb9e5e55@3x.png",
  "/assets/node_modules/@react-navigation/elements/lib/module/assets/clear-icon.c94f6478e7ae0cdd9f15de1fcb9e5e55@4x.png",
  "/assets/node_modules/@react-navigation/elements/lib/module/assets/close-icon.808e1b1b9b53114ec2838071a7e6daa7.png",
  "/assets/node_modules/@react-navigation/elements/lib/module/assets/close-icon.808e1b1b9b53114ec2838071a7e6daa7@2x.png",
  "/assets/node_modules/@react-navigation/elements/lib/module/assets/close-icon.808e1b1b9b53114ec2838071a7e6daa7@3x.png",
  "/assets/node_modules/@react-navigation/elements/lib/module/assets/close-icon.808e1b1b9b53114ec2838071a7e6daa7@4x.png",
  "/assets/node_modules/@react-navigation/elements/lib/module/assets/search-icon.286d67d3f74808a60a78d3ebf1a5fb57.png",
  "/favicon.ico",
  "/metadata.json"
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      for (const url of PRECACHE_ASSETS) {
        try {
          await cache.add(url);
        } catch (e) {
          // Bỏ qua nếu 1 asset phụ chưa sẵn sàng
        }
      }
    })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== API_CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // 1. Tài nguyên tĩnh (_expo JS/CSS, assets Fonts, favicon): Cache-First
  if (
    url.pathname.startsWith("/_expo/") ||
    url.pathname.startsWith("/assets/") ||
    url.pathname === "/favicon.ico"
  ) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, clone));
          }
          return networkRes;
        });
      })
    );
    return;
  }

  // 2. Điều hướng trang (F5 / Reload HTML): Network-First, Fallback về Cache /index.html
  if (req.mode === "navigate" || url.pathname === "/" || url.pathname === "/index.html") {
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((c) => c.put("/index.html", clone));
          }
          return networkRes;
        })
        .catch(async () => {
          const cachedIndex = await caches.match("/index.html");
          if (cachedIndex) return cachedIndex;
          return caches.match("/");
        })
    );
    return;
  }

  // 3. API GET danh sách cuộc họp & nhiệm vụ: Network-First kèm Offline Cache Fallback
  if (url.pathname.startsWith("/api/v1/meetings") || url.pathname.startsWith("/api/v1/tasks")) {
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const clone = networkRes.clone();
            caches.open(API_CACHE_NAME).then((c) => c.put(req, clone));
          }
          return networkRes;
        })
        .catch(() => caches.match(req))
    );
  }
});
