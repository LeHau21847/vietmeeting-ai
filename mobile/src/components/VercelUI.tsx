/**
 * src/components/VercelUI.tsx
 *
 * Bộ thành phần giao diện vi mô (Micro-interactions) chuẩn Vercel Geist Design System:
 *   1. ShimmerProgressBar: Thanh tiến trình phát sáng (Shimmer wave) khi AI đang bóc băng.
 *   2. ShimmerStatusPill: Huy hiệu phát sáng nhịp nhàng khi AI đang xử lý.
 *   3. MeetingSkeletonList: Khung xương tải dữ liệu (Skeleton Loading) mượt mà cho danh sách cuộc họp.
 */

import React, { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";

/**
 * Thanh tiến trình phát sáng nhẹ (Shimmer Effect) khi AI đang bóc băng / tạo biên bản.
 */
export function ShimmerProgressBar({
  progress,
  accentColor = "#2563EB",
  trackColor = "#1F232D",
  height = 8,
}: {
  progress: number;
  accentColor?: string;
  trackColor?: string;
  height?: number;
}): React.JSX.Element {
  const shimmerAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(0.75)).current;

  useEffect(() => {
    const loopShimmer = Animated.loop(
      Animated.timing(shimmerAnim, {
        toValue: 1,
        duration: 1500,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      })
    );
    const loopPulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 850,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0.65,
          duration: 850,
          useNativeDriver: true,
        }),
      ])
    );
    loopShimmer.start();
    loopPulse.start();
    return () => {
      loopShimmer.stop();
      loopPulse.stop();
    };
  }, [pulseAnim, shimmerAnim]);

  const clamped = Math.min(Math.max(progress, 4), 100);
  const translateX = shimmerAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [-180, 420],
  });

  return (
    <View
      style={[
        styles.progressTrack,
        {
          backgroundColor: trackColor,
          height,
          borderRadius: height / 2,
        },
      ]}
    >
      <Animated.View
        style={[
          styles.progressFill,
          {
            width: `${clamped}%`,
            backgroundColor: accentColor,
            height,
            borderRadius: height / 2,
            opacity: pulseAnim,
          },
        ]}
      >
        <Animated.View
          style={[
            styles.shimmerHighlight,
            {
              transform: [{ translateX }],
            },
          ]}
        />
      </Animated.View>
    </View>
  );
}

/**
 * Huy hiệu phát sáng vi mô khi AI đang bóc băng âm thanh.
 */
export function ShimmerStatusPill({
  label,
  isOffline = false,
}: {
  label: string;
  isOffline?: boolean;
}): React.JSX.Element {
  const glowAnim = useRef(new Animated.Value(0.55)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, {
          toValue: 1,
          duration: 900,
          useNativeDriver: true,
        }),
        Animated.timing(glowAnim, {
          toValue: 0.5,
          duration: 900,
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [glowAnim]);

  const color = isOffline ? "#F59E0B" : "#3B82F6";
  const bg = isOffline ? "rgba(245, 158, 11, 0.12)" : "rgba(37, 99, 235, 0.12)";
  const border = isOffline
    ? "rgba(245, 158, 11, 0.35)"
    : "rgba(59, 130, 246, 0.35)";

  return (
    <Animated.View
      style={[
        styles.shimmerPill,
        {
          backgroundColor: bg,
          borderColor: border,
          opacity: glowAnim,
        },
      ]}
    >
      <Feather
        name={isOffline ? "cpu" : "activity"}
        size={12}
        color={color}
      />
      <Text style={[styles.shimmerPillText, { color }]}>{label}</Text>
    </Animated.View>
  );
}

/**
 * Skeleton Loading mượt mà chuẩn Vercel khi đang tải danh sách cuộc họp.
 */
export function MeetingSkeletonList({
  isDark = true,
  count = 4,
}: {
  isDark?: boolean;
  count?: number;
}): React.JSX.Element {
  const pulse = useRef(new Animated.Value(0.42)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.88,
          duration: 950,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.42,
          duration: 950,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [pulse]);

  const cardBg = isDark ? "#151821" : "#FFFFFF";
  const borderCol = isDark ? "#232734" : "#E2E8F0";
  const boneBg = isDark ? "#1F2430" : "#E2E8F0";
  const boneSubtle = isDark ? "#191D28" : "#F1F5F9";

  return (
    <View style={styles.skeletonListWrap}>
      {Array.from({ length: count }).map((_, idx) => (
        <Animated.View
          key={idx}
          style={[
            styles.skeletonCard,
            {
              backgroundColor: cardBg,
              borderColor: borderCol,
              opacity: pulse,
            },
          ]}
        >
          {/* Hàng trên: Icon + Title + Status Pill */}
          <View style={styles.skeletonHeaderRow}>
            <View
              style={[
                styles.skeletonIconBox,
                { backgroundColor: boneBg },
              ]}
            />
            <View style={{ flex: 1, gap: 7 }}>
              <View
                style={[
                  styles.skeletonLine,
                  {
                    width: idx % 2 === 0 ? "72%" : "58%",
                    height: 14,
                    backgroundColor: boneBg,
                  },
                ]}
              />
              <View
                style={[
                  styles.skeletonLine,
                  {
                    width: "36%",
                    height: 10,
                    backgroundColor: boneSubtle,
                  },
                ]}
              />
            </View>
            <View
              style={[
                styles.skeletonBadge,
                { backgroundColor: boneBg },
              ]}
            />
          </View>

          {/* Hàng giữa: Tóm tắt 2 dòng */}
          <View style={styles.skeletonBodyWrap}>
            <View
              style={[
                styles.skeletonLine,
                { width: "94%", height: 11, backgroundColor: boneSubtle },
              ]}
            />
            <View
              style={[
                styles.skeletonLine,
                { width: "68%", height: 11, backgroundColor: boneSubtle },
              ]}
            />
          </View>

          {/* Hàng dưới: Tiến độ công việc & Nút hành động */}
          <View style={styles.skeletonFooterRow}>
            <View
              style={[
                styles.skeletonLine,
                { width: 110, height: 10, backgroundColor: boneBg },
              ]}
            />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <View
                style={[
                  styles.skeletonBtn,
                  { width: 84, backgroundColor: boneSubtle },
                ]}
              />
              <View
                style={[
                  styles.skeletonBtn,
                  { width: 64, backgroundColor: boneBg },
                ]}
              />
            </View>
          </View>
        </Animated.View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  progressTrack: {
    width: "100%",
    overflow: "hidden",
    position: "relative",
  },
  progressFill: {
    overflow: "hidden",
    position: "relative",
  },
  shimmerHighlight: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 110,
    backgroundColor: "rgba(255, 255, 255, 0.35)",
    borderRadius: 8,
  },
  shimmerPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  shimmerPillText: {
    fontSize: 11.5,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  skeletonListWrap: {
    gap: 12,
    paddingVertical: 4,
  },
  skeletonCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    gap: 14,
  },
  skeletonHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  skeletonIconBox: {
    width: 36,
    height: 36,
    borderRadius: 8,
  },
  skeletonLine: {
    borderRadius: 5,
  },
  skeletonBadge: {
    width: 82,
    height: 22,
    borderRadius: 6,
  },
  skeletonBodyWrap: {
    gap: 7,
    paddingLeft: 48,
  },
  skeletonFooterRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: 48,
    paddingTop: 4,
  },
  skeletonBtn: {
    height: 26,
    borderRadius: 6,
  },
});

