/**
 * src/components/VercelToast.tsx
 *
 * Hệ thống Toast Notifications chuẩn Vercel Geist Design System (Sonner-inspired).
 * - Zero-Emoji UI Policy: 100% Vector Icons từ Feather.
 * - Hiệu ứng trượt mượt mà (Animated spring + fade).
 * - Hỗ trợ gọi imperative `showToast(...)` từ bất kỳ màn hình hoặc hàm xử lý nào.
 * - Tự động phát hiện sự kiện rớt mạng / có mạng trên trình duyệt.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";

export type ToastType = "success" | "warning" | "error" | "info" | "offline";

export interface ToastOptions {
  title: string;
  description?: string;
  type?: ToastType;
  duration?: number;
}

interface ToastItem extends ToastOptions {
  id: string;
  createdAt: number;
}

type ToastListener = (toast: ToastItem) => void;

const listeners = new Set<ToastListener>();
let lastToastKey = "";
let lastToastTime = 0;

/**
 * Hiển thị thông báo Toast góc màn hình chuẩn Vercel Design System.
 */
export function showToast(input: ToastOptions | string, type: ToastType = "info"): void {
  const opts: ToastOptions =
    typeof input === "string" ? { title: input, type } : input;

  const now = Date.now();
  const dedupKey = `${opts.type || "info"}:${opts.title}`;
  if (dedupKey === lastToastKey && now - lastToastTime < 2800) {
    return;
  }
  lastToastKey = dedupKey;
  lastToastTime = now;

  const item: ToastItem = {
    id: `toast_${now}_${Math.random().toString(36).slice(2, 7)}`,
    title: opts.title,
    description: opts.description,
    type: opts.type || "info",
    duration: opts.duration ?? 3800,
    createdAt: now,
  };

  listeners.forEach((fn) => fn(item));
}

function SingleToastCard({
  item,
  onDismiss,
}: {
  item: ToastItem;
  onDismiss: (id: string) => void;
}): React.JSX.Element {
  const translateY = useRef(new Animated.Value(20)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.96)).current;

  const dismiss = useCallback(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 0,
        duration: 180,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 12,
        duration: 180,
        useNativeDriver: true,
      }),
    ]).start(() => onDismiss(item.id));
  }, [item.id, onDismiss, opacity, translateY]);

  useEffect(() => {
    Animated.parallel([
      Animated.spring(translateY, {
        toValue: 0,
        damping: 20,
        stiffness: 240,
        mass: 0.8,
        useNativeDriver: true,
      }),
      Animated.spring(scale, {
        toValue: 1,
        damping: 20,
        stiffness: 240,
        mass: 0.8,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: 180,
        useNativeDriver: true,
      }),
    ]).start();

    const timer = setTimeout(dismiss, item.duration || 3800);
    return () => clearTimeout(timer);
  }, [dismiss, item.duration, opacity, scale, translateY]);

  const getVisuals = (t?: ToastType) => {
    switch (t) {
      case "success":
        return {
          icon: "check-circle" as const,
          color: "#10B981",
          bg: "rgba(16, 185, 129, 0.12)",
          border: "rgba(16, 185, 129, 0.35)",
        };
      case "warning":
      case "offline":
        return {
          icon: (t === "offline" ? "wifi-off" : "alert-triangle") as
            | "wifi-off"
            | "alert-triangle",
          color: "#F59E0B",
          bg: "rgba(245, 158, 11, 0.14)",
          border: "rgba(245, 158, 11, 0.42)",
        };
      case "error":
        return {
          icon: "alert-circle" as const,
          color: "#EF4444",
          bg: "rgba(239, 68, 68, 0.12)",
          border: "rgba(239, 68, 68, 0.38)",
        };
      default:
        return {
          icon: "info" as const,
          color: "#3B82F6",
          bg: "rgba(59, 130, 246, 0.12)",
          border: "rgba(59, 130, 246, 0.35)",
        };
    }
  };

  const v = getVisuals(item.type);

  return (
    <Animated.View
      style={[
        styles.toastCard,
        {
          borderColor: v.border,
          opacity,
          transform: [{ translateY }, { scale }],
        },
      ]}
    >
      <View style={[styles.iconBadge, { backgroundColor: v.bg }]}>
        <Feather name={v.icon} size={15} color={v.color} />
      </View>

      <View style={styles.textWrap}>
        <Text style={styles.toastTitle} numberOfLines={2}>
          {item.title}
        </Text>
        {item.description ? (
          <Text style={styles.toastDesc} numberOfLines={2}>
            {item.description}
          </Text>
        ) : null}
      </View>

      <Pressable
        onPress={dismiss}
        hitSlop={8}
        style={({ pressed }) => [
          styles.closeBtn,
          pressed && { opacity: 0.6 },
        ]}
      >
        <Feather name="x" size={14} color="#64748B" />
      </Pressable>
    </Animated.View>
  );
}

export function VercelToastHost(): React.JSX.Element | null {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    const handler: ToastListener = (newItem) => {
      setToasts((prev) => [...prev.slice(-3), newItem]);
    };
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }, []);

  // Tự động lắng nghe sự kiện Offline / Online trên Web
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;

    const handleOffline = () => {
      showToast({
        title: "Mất kết nối Internet - Chuyển sang Local AI",
        description: "Hệ thống tự động định tuyến sang Faster-Whisper & Ollama nội bộ.",
        type: "offline",
        duration: 5000,
      });
    };

    const handleOnline = () => {
      showToast({
        title: "Đã khôi phục kết nối mạng",
        description: "Hệ thống Hybrid AI đã sẵn sàng đồng bộ.",
        type: "success",
        duration: 3200,
      });
    };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  const handleDismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  if (toasts.length === 0) return null;

  return (
    <View pointerEvents="box-none" style={styles.hostContainer}>
      {toasts.map((item) => (
        <SingleToastCard key={item.id} item={item} onDismiss={handleDismiss} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  hostContainer: {
    position: "absolute",
    bottom: 24,
    right: 24,
    zIndex: 99999,
    gap: 10,
    maxWidth: 380,
    width: "90%",
    alignItems: "flex-end",
  },
  toastCard: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#14171F",
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 11,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.36,
    shadowRadius: 16,
    elevation: 10,
  },
  iconBadge: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  textWrap: {
    flex: 1,
    gap: 2,
  },
  toastTitle: {
    color: "#F8FAFC",
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: -0.1,
  },
  toastDesc: {
    color: "#94A3B8",
    fontSize: 11.5,
    lineHeight: 16,
  },
  closeBtn: {
    width: 24,
    height: 24,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
});

