/**
 * src/screens/HomeScreen.tsx
 *
 * Bảng điều khiển Quản lý Cuộc họp – VietMeeting AI
 * Thiết kế theo chuẩn Human-Crafted UI: Swiss Editorial & Linear Palette,
 * Zero-Emoji, Feather Vector Icons, hỗ trợ Giao diện Sáng / Tối (Light / Dark Theme).
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Feather } from "@expo/vector-icons";
import axios, { AxiosError } from "axios";

import { API_ENDPOINTS, API_TIMEOUT_SHORT_MS, BASE_URL } from "@/constants/api";
import { AIEngineBadge, AIConfigModal } from "@/components/AIConfigModal";
import type {
  AIConfigData,
  APIErrorResponse,
  MeetingCreateBody,
  MeetingSummary,
  MeetingStatus,
  RootStackParamList,
} from "@/types/meeting";

interface CrossMeetingTask {
  id: number;
  meeting_id: number;
  title: string;
  status: string;
  due_date?: string | null;
  description?: string | null;
}

type NavProp = NativeStackNavigationProp<RootStackParamList, "Home">;

/** Format ISO date → "DD/MM/YYYY · HH:MM" */
function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

// Gợi ý tiêu đề cuộc họp chuẩn hành chính & doanh nghiệp
const TITLE_SUGGESTIONS = [
  "Họp giao ban công tác tuần",
  "Đánh giá tiến độ dự án chuyển đổi số",
  "Họp ban chỉ đạo kế hoạch quý",
  "Thảo luận kiến trúc hệ thống và bảo mật",
];

export default function HomeScreen(): React.JSX.Element {
  const navigation = useNavigation<NavProp>();

  // Theme State: 'dark' | 'light'
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const isDark = theme === "dark";

  // Palette động theo theme
  const palette = useMemo(() => {
    if (isDark) {
      return {
        canvas: "#0C0E12",
        card: "#161920",
        surface: "#1A1D26",
        surfaceHover: "#202430",
        border: "#262932",
        borderSubtle: "rgba(255, 255, 255, 0.06)",
        textPrimary: "#F8FAFC",
        textSecondary: "#94A3B8",
        textMuted: "#64748B",
        accent: "#2563EB",
        accentLight: "#60A5FA",
        accentBg: "rgba(37, 99, 235, 0.12)",
        statusBg: "rgba(100, 116, 139, 0.1)",
        inputBg: "#111318",
        statusBar: "light-content" as const,
      };
    }
    return {
      canvas: "#F8FAFC",
      card: "#FFFFFF",
      surface: "#F1F5F9",
      surfaceHover: "#E2E8F0",
      border: "#E2E8F0",
      borderSubtle: "rgba(0, 0, 0, 0.06)",
      textPrimary: "#0F172A",
      textSecondary: "#475569",
      textMuted: "#94A3B8",
      accent: "#1D4ED8",
      accentLight: "#2563EB",
      accentBg: "rgba(29, 78, 216, 0.08)",
      statusBg: "rgba(241, 245, 249, 1)",
      inputBg: "#FFFFFF",
      statusBar: "dark-content" as const,
    };
  }, [isDark]);

  // Cấu hình trạng thái cuộc họp không dùng emoji
  const statusConfig: Record<
    MeetingStatus,
    { label: string; color: string; bg: string; border: string; icon: keyof typeof Feather.glyphMap }
  > = useMemo(
    () => ({
      created: {
        label: "Chưa ghi âm",
        color: isDark ? "#38BDF8" : "#0284C7",
        bg: isDark ? "rgba(56, 189, 248, 0.1)" : "rgba(2, 132, 199, 0.08)",
        border: isDark ? "rgba(56, 189, 248, 0.25)" : "rgba(2, 132, 199, 0.2)",
        icon: "mic",
      },
      processing: {
        label: "Đang xử lý AI",
        color: isDark ? "#FBBF24" : "#D97706",
        bg: isDark ? "rgba(251, 191, 36, 0.1)" : "rgba(217, 119, 6, 0.08)",
        border: isDark ? "rgba(251, 191, 36, 0.25)" : "rgba(217, 119, 6, 0.2)",
        icon: "loader",
      },
      completed: {
        label: "Đã có biên bản",
        color: isDark ? "#34D399" : "#059669",
        bg: isDark ? "rgba(52, 211, 153, 0.1)" : "rgba(5, 150, 105, 0.08)",
        border: isDark ? "rgba(52, 211, 153, 0.25)" : "rgba(5, 150, 105, 0.2)",
        icon: "check-circle",
      },
      failed: {
        label: "Lỗi xử lý",
        color: isDark ? "#F87171" : "#DC2626",
        bg: isDark ? "rgba(248, 113, 113, 0.1)" : "rgba(220, 38, 38, 0.08)",
        border: isDark ? "rgba(248, 113, 113, 0.25)" : "rgba(220, 38, 38, 0.2)",
        icon: "alert-circle",
      },
    }),
    [isDark]
  );

  // State
  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string>("");

  // Search & Filter
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  // Modal tạo meeting
  const [modalVisible, setModalVisible] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  // Modal cấu hình AI
  const [aiConfigModalVisible, setAiConfigModalVisible] = useState(false);
  const [aiConfig, setAiConfig] = useState<AIConfigData | null>(null);

  // Cross-meeting Urgent Tasks
  const [recentTasks, setRecentTasks] = useState<CrossMeetingTask[]>([]);
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);

  // Đọc cấu hình AI từ Backend để đồng bộ tức thì trên Header
  const fetchAiConfig = useCallback(async () => {
    try {
      const res = await axios.get<AIConfigData>(API_ENDPOINTS.aiConfig, {
        timeout: API_TIMEOUT_SHORT_MS,
      });
      setAiConfig(res.data);
    } catch {
      // ignore
    }
  }, []);

  // Đọc danh sách nhiệm vụ toàn hệ thống
  const fetchTasks = useCallback(async () => {
    setIsLoadingTasks(true);
    try {
      const res = await axios.get<CrossMeetingTask[]>(`${BASE_URL}/api/v1/tasks?limit=6`, {
        timeout: API_TIMEOUT_SHORT_MS,
      });
      setRecentTasks(res.data);
    } catch {
      // ignore
    } finally {
      setIsLoadingTasks(false);
    }
  }, []);

  // Fetch danh sách meetings
  const fetchMeetings = useCallback(async (isRefresh = false) => {
    if (isRefresh) setIsRefreshing(true);
    else setIsLoading(true);
    setLoadError("");

    try {
      const response = await axios.get<MeetingSummary[]>(
        API_ENDPOINTS.listMeetings,
        { timeout: API_TIMEOUT_SHORT_MS }
      );
      setMeetings(response.data);
    } catch (error) {
      let msg = "Không thể tải danh sách cuộc họp.";
      if (axios.isAxiosError(error)) {
        const axErr = error as AxiosError<APIErrorResponse>;
        if (axErr.code === "ECONNREFUSED" || axErr.message.includes("Network Error")) {
          msg = "Không kết nối được Backend FastAPI (Port 8000). Vui lòng kiểm tra server.";
        } else if (axErr.response?.data?.message) {
          msg = axErr.response.data.message;
        }
      }
      setLoadError(msg);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchMeetings();
    fetchAiConfig();
    fetchTasks();
  }, [fetchMeetings, fetchAiConfig, fetchTasks]);

  // Tự động kết nối lại (Auto-Retry Polling) mỗi 2.5s khi gặp lỗi mạng (ví dụ backend đang khởi động)
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    if (loadError) {
      timer = setInterval(() => {
        fetchMeetings(true);
        fetchAiConfig();
        fetchTasks();
      }, 2500);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [loadError, fetchMeetings, fetchAiConfig, fetchTasks]);

  // Thống kê nhanh
  const stats = useMemo(() => {
    const total = meetings.length;
    const completed = meetings.filter((m) => m.status === "completed").length;
    const pending = meetings.filter((m) => m.status === "created").length;
    const processing = meetings.filter((m) => m.status === "processing").length;
    return { total, completed, pending, processing };
  }, [meetings]);

  // Danh sách đã lọc theo search query và status filter
  const filteredMeetings = useMemo(() => {
    return meetings.filter((m) => {
      const matchesSearch =
        searchQuery.trim() === "" ||
        m.title.toLowerCase().includes(searchQuery.toLowerCase().trim());
      const matchesFilter =
        statusFilter === "all" || m.status === statusFilter;
      return matchesSearch && matchesFilter;
    });
  }, [meetings, searchQuery, statusFilter]);

  // Tạo meeting mới
  const handleCreateMeeting = async () => {
    const trimmedTitle = newTitle.trim();
    if (trimmedTitle.length < 3) {
      setCreateError("Tiêu đề cuộc họp phải có ít nhất 3 ký tự.");
      return;
    }

    setIsCreating(true);
    setCreateError("");

    try {
      const body: MeetingCreateBody = { title: trimmedTitle };
      const response = await axios.post<MeetingSummary>(
        API_ENDPOINTS.createMeeting,
        body,
        {
          headers: { "Content-Type": "application/json" },
          timeout: API_TIMEOUT_SHORT_MS,
        }
      );

      const newMeeting = response.data;
      setModalVisible(false);
      setNewTitle("");
      setIsCreating(false);

      setMeetings((prev) => [newMeeting, ...prev]);

      navigation.navigate("Recording", {
        meetingId: newMeeting.id,
        meetingTitle: newMeeting.title,
        meetingStatus: newMeeting.status,
      });
    } catch (error) {
      setIsCreating(false);
      let msg = "Không thể tạo cuộc họp. Vui lòng thử lại.";
      if (axios.isAxiosError(error)) {
        const axErr = error as AxiosError<APIErrorResponse>;
        if (axErr.code === "ECONNREFUSED" || axErr.message.includes("Network Error")) {
          msg = "Mất kết nối với máy chủ.";
        } else if (axErr.response?.data?.message) {
          msg = axErr.response.data.message;
        }
      }
      setCreateError(msg);
    }
  };

  const handleOpenModal = () => {
    setNewTitle("");
    setCreateError("");
    setModalVisible(true);
  };

  const handleCloseModal = () => {
    if (isCreating) return;
    setModalVisible(false);
    setNewTitle("");
    setCreateError("");
  };

  // Xóa cuộc họp
  const handleDeleteMeeting = (meeting: MeetingSummary) => {
    const proceedDelete = async () => {
      try {
        await axios.delete(`${BASE_URL}/api/v1/meetings/${meeting.id}`, {
          timeout: API_TIMEOUT_SHORT_MS,
        });
        setMeetings((prev) => prev.filter((m) => m.id !== meeting.id));
      } catch {
        Alert.alert("Lỗi", "Không thể xóa cuộc họp. Vui lòng thử lại.");
      }
    };

    if (Platform.OS === "web") {
      if (window.confirm(`Xác nhận xóa vĩnh viễn cuộc họp: "${meeting.title}"?`)) {
        proceedDelete();
      }
    } else {
      Alert.alert(
        "Xác nhận xóa",
        `Bạn có chắc chắn muốn xóa "${meeting.title}"? Dữ liệu không thể khôi phục sau khi xóa.`,
        [
          { text: "Hủy", style: "cancel" },
          { text: "Xóa vĩnh viễn", style: "destructive", onPress: proceedDelete },
        ]
      );
    }
  };

  const handleMeetingPress = (meeting: MeetingSummary) => {
    navigation.navigate("Recording", {
      meetingId: meeting.id,
      meetingTitle: meeting.title,
      meetingStatus: meeting.status,
    });
  };

  // Tải nhanh file Word (.doc) 1-click
  const handleDownloadDoc = (meeting: MeetingSummary) => {
    const url = `${BASE_URL}/api/v1/meetings/${meeting.id}/export-doc`;
    if (Platform.OS === "web") {
      try {
        window.open(url, "_blank");
      } catch {
        // fallback
      }
    } else {
      Alert.alert("Thông báo", "Vui lòng mở ứng dụng trên trình duyệt web để tải file Word trực tiếp.");
    }
  };

  // Khởi tạo nhanh phiên họp từ tệp ghi âm sẵn có (.mp3, .wav, .m4a)
  const handleAudioFileSelect = () => {
    if (Platform.OS === "web") {
      try {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "audio/*,.mp3,.wav,.m4a,.aac,.webm,.ogg";
        input.onchange = async (e: any) => {
          const file = e.target?.files?.[0];
          if (!file) return;
          const cleanName = file.name.replace(/\.[^/.]+$/, "").replace(/[_-]/g, " ");
          const title = cleanName.trim() || "Cuộc họp ghi âm từ tệp";
          try {
            // 1. Tạo cuộc họp mới
            const createRes = await axios.post<MeetingSummary>(
              API_ENDPOINTS.createMeeting,
              { title },
              { headers: { "Content-Type": "application/json" } }
            );
            const newM = createRes.data;
            setMeetings((prev) => [newM, ...prev]);

            // 2. Chuyển thẳng vào Studio
            navigation.navigate("Recording", {
              meetingId: newM.id,
              meetingTitle: newM.title,
              meetingStatus: "created",
            });
          } catch {
            Alert.alert("Lỗi", "Không thể khởi tạo cuộc họp từ file âm thanh.");
          }
        };
        input.click();
      } catch {
        handleOpenModal();
      }
    } else {
      handleOpenModal();
    }
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: palette.canvas }]}>
      <StatusBar barStyle={palette.statusBar} backgroundColor={palette.canvas} />
      <View style={styles.mainContainer}>

        {/* ==================================================================
            HEADER
        ================================================================== */}
        <View style={[styles.header, { borderBottomColor: palette.border }]}>
          <View style={styles.headerLeft}>
            <View style={[styles.logoBadge, { backgroundColor: palette.accentBg, borderColor: palette.border }]}>
              <Feather name="layers" size={18} color={palette.accent} />
            </View>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={[styles.appTitle, { color: palette.textPrimary }]}>VietMeeting AI</Text>
                <View style={[styles.hybridTag, { borderColor: palette.border }]}>
                  <Text style={[styles.hybridTagText, { color: palette.accent }]}>HYBRID ENGINE</Text>
                </View>
              </View>
              <Text style={[styles.appSubtitle, { color: palette.textSecondary }]}>
                Hệ thống ghi âm, lập biên bản hành chính & phân công nhiệm vụ
              </Text>
            </View>
          </View>

          <View style={styles.headerRight}>
            {/* Chuyển đổi giao diện Sáng / Tối */}
            <Pressable
              onPress={() => setTheme(isDark ? "light" : "dark")}
              hitSlop={6}
              accessibilityLabel="Chuyển đổi giao diện sáng tối"
              style={({ pressed }) => [
                styles.iconButton,
                { backgroundColor: palette.surface, borderColor: palette.border },
                pressed && styles.buttonPressed,
              ]}
            >
              <Feather name={isDark ? "sun" : "moon"} size={16} color={palette.textSecondary} />
            </Pressable>

            {/* Badge AI Engine Switcher (Đồng bộ tức thì cấu hình từ Backend) */}
            <AIEngineBadge
              onPress={() => setAiConfigModalVisible(true)}
              currentConfig={aiConfig}
            />

            {/* Làm mới */}
            <Pressable
              onPress={() => {
                fetchMeetings(true);
                fetchAiConfig();
                fetchTasks();
              }}
              style={({ pressed }) => [
                styles.iconButton,
                { backgroundColor: palette.surface, borderColor: palette.border },
                pressed && styles.buttonPressed,
              ]}
            >
              <Feather name="rotate-cw" size={15} color={palette.textSecondary} />
            </Pressable>

            {/* Tạo cuộc họp mới */}
            <Pressable
              onPress={handleOpenModal}
              style={({ pressed }) => [
                styles.headerCtaButton,
                { backgroundColor: palette.accent },
                pressed && styles.buttonPressed,
              ]}
            >
              <Feather name="plus" size={16} color="#FFFFFF" />
              <Text style={styles.headerCtaText}>Tạo biên bản mới</Text>
            </Pressable>
          </View>
        </View>

        {/* ==================================================================
            BENTO KPI METRICS CARDS
        ================================================================== */}
        <View style={styles.statsRow}>
          <View style={[styles.statCard, { backgroundColor: palette.card, borderColor: palette.border }]}>
            <View style={[styles.statIconBox, { backgroundColor: palette.surface }]}>
              <Feather name="folder" size={16} color={palette.accent} />
            </View>
            <View>
              <Text style={[styles.statNumber, { color: palette.textPrimary }]}>{stats.total}</Text>
              <Text style={[styles.statLabel, { color: palette.textSecondary }]}>Tổng cuộc họp</Text>
            </View>
          </View>

          <View style={[styles.statCard, { backgroundColor: palette.card, borderColor: palette.border }]}>
            <View style={[styles.statIconBox, { backgroundColor: palette.surface }]}>
              <Feather name="check-square" size={16} color="#10B981" />
            </View>
            <View>
              <Text style={[styles.statNumber, { color: palette.textPrimary }]}>{stats.completed}</Text>
              <Text style={[styles.statLabel, { color: palette.textSecondary }]}>Đã có biên bản</Text>
            </View>
          </View>

          <View style={[styles.statCard, { backgroundColor: palette.card, borderColor: palette.border }]}>
            <View style={[styles.statIconBox, { backgroundColor: palette.surface }]}>
              <Feather name="clock" size={16} color="#F59E0B" />
            </View>
            <View>
              <Text style={[styles.statNumber, { color: palette.textPrimary }]}>{stats.pending}</Text>
              <Text style={[styles.statLabel, { color: palette.textSecondary }]}>Chờ ghi âm</Text>
            </View>
          </View>

          <View style={[styles.statCard, { backgroundColor: palette.card, borderColor: palette.border }]}>
            <View style={[styles.statIconBox, { backgroundColor: palette.surface }]}>
              <Feather name="shield" size={16} color="#0284C7" />
            </View>
            <View>
              <Text style={[styles.statNumber, { color: palette.textPrimary }]}>100%</Text>
              <Text style={[styles.statLabel, { color: palette.textSecondary }]}>Bảo mật nội bộ</Text>
            </View>
          </View>
        </View>

        {/* ==================================================================
            KHÔNG GIAN LÀM VIỆC CHÍNH (DESKTOP 2 CỘT 70% - 30%)
        ================================================================== */}
        <View style={styles.workspaceRow}>
          {/* CỘT TRÁI (70%): DANH SÁCH CUỘC HỌP */}
          <View style={styles.mainColumn}>
            {/* TÌM KIẾM & BỘ LỌC */}
            <View style={styles.filterSection}>
              <View style={[styles.searchBar, { backgroundColor: palette.card, borderColor: palette.border }]}>
                <Feather name="search" size={15} color={palette.textMuted} style={{ marginRight: 8 }} />
                <TextInput
                  style={[styles.searchInput, { color: palette.textPrimary }]}
                  placeholder="Tìm kiếm theo tiêu đề cuộc họp..."
                  placeholderTextColor={palette.textMuted}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                />
                {searchQuery.length > 0 && (
                  <Pressable onPress={() => setSearchQuery("")} hitSlop={8}>
                    <Feather name="x" size={15} color={palette.textMuted} />
                  </Pressable>
                )}
              </View>

              <View style={styles.filterTabs}>
                {[
                  { id: "all", label: "Tất cả", count: stats.total },
                  { id: "completed", label: "Đã xong", count: stats.completed },
                  { id: "created", label: "Chờ ghi", count: stats.pending },
                  { id: "processing", label: "Đang xử lý", count: stats.processing },
                ].map((tab) => {
                  const active = statusFilter === tab.id;
                  return (
                    <Pressable
                      key={tab.id}
                      onPress={() => setStatusFilter(tab.id)}
                      style={[
                        styles.filterChip,
                        {
                          backgroundColor: active ? palette.accentBg : palette.card,
                          borderColor: active ? palette.accent : palette.border,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.filterChipText,
                          { color: active ? palette.accent : palette.textSecondary },
                          active && { fontWeight: "600" },
                        ]}
                      >
                        {tab.label}
                      </Text>
                      <View
                        style={[
                          styles.filterChipCount,
                          { backgroundColor: active ? palette.accent : palette.surface },
                        ]}
                      >
                        <Text
                          style={[
                            styles.filterChipCountText,
                            { color: active ? "#FFFFFF" : palette.textMuted },
                          ]}
                        >
                          {tab.count}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {/* DANH SÁCH CUỘC HỌP */}
            {isLoading ? (
              <View style={styles.centerContainer}>
                <ActivityIndicator size="small" color={palette.accent} />
                <Text style={[styles.loadingText, { color: palette.textSecondary }]}>
                  Đang tải danh sách cuộc họp...
                </Text>
              </View>
            ) : loadError ? (
              <View style={styles.centerContainer}>
                <View style={[styles.errorIconBox, { backgroundColor: "rgba(239, 68, 68, 0.1)" }]}>
                  <Feather name="wifi-off" size={24} color="#EF4444" />
                </View>
                <Text style={styles.errorTitle}>Lỗi kết nối máy chủ</Text>
                <Text style={[styles.errorMessage, { color: palette.textSecondary }]}>{loadError}</Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginVertical: 8 }}>
                  <ActivityIndicator size="small" color={palette.accent} />
                  <Text style={{ fontSize: 12, color: palette.textMuted }}>Đang tự động kết nối lại mỗi 2.5s...</Text>
                </View>
                <Pressable
                  onPress={() => {
                    fetchMeetings();
                    fetchAiConfig();
                    fetchTasks();
                  }}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    { backgroundColor: palette.accent },
                    pressed && styles.buttonPressed,
                  ]}
                >
                  <Feather name="rotate-cw" size={14} color="#FFFFFF" style={{ marginRight: 6 }} />
                  <Text style={styles.primaryButtonText}>Thử lại ngay</Text>
                </Pressable>
              </View>
            ) : (
              <FlatList
                data={filteredMeetings}
                keyExtractor={(item) => String(item.id)}
                contentContainerStyle={styles.listContent}
                showsVerticalScrollIndicator={false}
                refreshControl={
                  <RefreshControl
                    refreshing={isRefreshing}
                    onRefresh={() => {
                      fetchMeetings(true);
                      fetchTasks();
                    }}
                    tintColor={palette.accent}
                    colors={[palette.accent]}
                  />
                }
                ListEmptyComponent={
                  <View style={styles.emptyContainer}>
                    <View style={[styles.emptyIconBox, { backgroundColor: palette.surface, borderColor: palette.border }]}>
                      <Feather name="file-text" size={32} color={palette.textMuted} />
                    </View>
                    <Text style={[styles.emptyTitle, { color: palette.textPrimary }]}>
                      {searchQuery || statusFilter !== "all"
                        ? "Không tìm thấy cuộc họp phù hợp"
                        : "Chưa có cuộc họp nào trong danh sách"}
                    </Text>
                    <Text style={[styles.emptySubtitle, { color: palette.textSecondary }]}>
                      {searchQuery || statusFilter !== "all"
                        ? "Vui lòng thử lại với từ khóa khác hoặc xóa bộ lọc trạng thái."
                        : "Bắt đầu bằng việc tạo cuộc họp mới để tiến hành ghi âm và tạo biên bản chuẩn thể thức."}
                    </Text>
                    <Pressable
                      onPress={handleOpenModal}
                      style={({ pressed }) => [
                        styles.emptyCreateButton,
                        { backgroundColor: palette.accent },
                        pressed && styles.buttonPressed,
                      ]}
                    >
                      <Feather name="plus" size={16} color="#FFFFFF" style={{ marginRight: 6 }} />
                      <Text style={styles.emptyCreateButtonText}>Tạo biên bản đầu tiên</Text>
                    </Pressable>
                  </View>
                }
                renderItem={({ item }) => (
                  <MeetingCardItem
                    meeting={item}
                    cfg={statusConfig[item.status] ?? statusConfig.created}
                    palette={palette}
                    onPress={() => handleMeetingPress(item)}
                    onDelete={() => handleDeleteMeeting(item)}
                    onDownloadDoc={() => handleDownloadDoc(item)}
                  />
                )}
                ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
              />
            )}
          </View>

          {/* CỘT PHẢI (30%): BẢNG ĐIỀU HÀNH TÁC VỤ & THEO DÕI (EXECUTIVE ACTION CENTER) */}
          {Platform.OS === "web" && (
            <View style={styles.sidebarCol}>
              {/* Thẻ 1: Khởi tạo nhanh từ tệp âm thanh có sẵn */}
              <View style={[styles.sidebarCard, { backgroundColor: palette.card, borderColor: palette.border }]}>
                <View style={styles.sidebarCardHeader}>
                  <View style={[styles.sidebarCardIcon, { backgroundColor: palette.accentBg }]}>
                    <Feather name="upload-cloud" size={16} color={palette.accent} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.sidebarCardTitle, { color: palette.textPrimary }]}>
                      Nạp tệp âm thanh nhanh
                    </Text>
                    <Text style={[styles.sidebarCardSub, { color: palette.textSecondary }]}>
                      Khởi tạo từ file ghi âm .mp3, .wav, .m4a
                    </Text>
                  </View>
                </View>

                <Pressable
                  onPress={handleAudioFileSelect}
                  style={({ pressed }) => [
                    styles.dropzoneBox,
                    { borderColor: palette.accent, backgroundColor: palette.surface },
                    pressed && styles.buttonPressed,
                  ]}
                >
                  <Feather name="file-plus" size={22} color={palette.accent} />
                  <Text style={[styles.dropzoneTitle, { color: palette.textPrimary }]}>
                    Tải file âm thanh có sẵn
                  </Text>
                  <Text style={[styles.dropzoneHint, { color: palette.textMuted }]}>
                    Nhấp để duyệt tệp từ máy tính
                  </Text>
                </Pressable>
              </View>

              {/* Thẻ 2: Theo dõi nhiệm vụ trọng tâm (Cross-meeting Action Tracker) */}
              <View style={[styles.sidebarCard, { backgroundColor: palette.card, borderColor: palette.border }]}>
                <View style={styles.sidebarCardHeader}>
                  <View style={[styles.sidebarCardIcon, { backgroundColor: "rgba(16, 185, 129, 0.12)" }]}>
                    <Feather name="check-square" size={15} color="#10B981" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.sidebarCardTitle, { color: palette.textPrimary }]}>
                      Nhiệm vụ trọng tâm
                    </Text>
                    <Text style={[styles.sidebarCardSub, { color: palette.textSecondary }]}>
                      Đầu việc phát sinh từ các cuộc họp
                    </Text>
                  </View>
                </View>

                {isLoadingTasks ? (
                  <View style={styles.sidebarLoadingBox}>
                    <ActivityIndicator size="small" color={palette.accent} />
                  </View>
                ) : recentTasks.length === 0 ? (
                  <View style={styles.emptyTasksBox}>
                    <Feather name="check-circle" size={18} color="#10B981" />
                    <Text style={[styles.emptyTasksText, { color: palette.textMuted }]}>
                      Toàn bộ nhiệm vụ đã được xử lý xong
                    </Text>
                  </View>
                ) : (
                  <View style={{ gap: 8 }}>
                    {recentTasks.slice(0, 5).map((t) => {
                      const isDone = t.status === "done";
                      return (
                        <Pressable
                          key={t.id}
                          onPress={() => {
                            const m = meetings.find((item) => item.id === t.meeting_id);
                            if (m) {
                              navigation.navigate("Recording", {
                                meetingId: m.id,
                                meetingTitle: m.title,
                                meetingStatus: m.status,
                              });
                            }
                          }}
                          style={({ pressed }) => [
                            styles.taskItemCard,
                            { backgroundColor: palette.surface, borderColor: palette.border },
                            pressed && styles.buttonPressed,
                          ]}
                        >
                          <View style={styles.taskItemHeader}>
                            <View
                              style={[
                                styles.taskStatusDot,
                                { backgroundColor: isDone ? "#10B981" : "#F59E0B" },
                              ]}
                            />
                            <Text
                              style={[
                                styles.taskItemTitle,
                                { color: palette.textPrimary },
                                isDone && { textDecorationLine: "line-through", opacity: 0.6 },
                              ]}
                              numberOfLines={2}
                            >
                              {t.title}
                            </Text>
                          </View>
                          <View style={styles.taskItemMeta}>
                            <Text style={[styles.taskMeetingCode, { color: palette.accent }]}>
                              #{String(t.meeting_id).padStart(4, "0")}/BB-CH
                            </Text>
                            {t.due_date ? (
                              <Text style={[styles.taskDueDate, { color: palette.textMuted }]}>
                                {String(t.due_date).split("·")[0].trim()}
                              </Text>
                            ) : null}
                          </View>
                        </Pressable>
                      );
                    })}
                  </View>
                )}
              </View>
            </View>
          )}
        </View>

        {/* Nút nổi Tạo cuộc họp trên Mobile */}
        {Platform.OS !== "web" && (
          <View style={styles.fabContainer}>
            <Pressable
              onPress={handleOpenModal}
              style={({ pressed }) => [
                styles.fabButton,
                { backgroundColor: palette.accent },
                pressed && styles.buttonPressed,
              ]}
            >
              <Feather name="plus" size={18} color="#FFFFFF" />
              <Text style={styles.fabText}>Tạo mới</Text>
            </Pressable>
          </View>
        )}

        {/* ==================================================================
            MODAL TẠO CUỘC HỌP MỚI
        ================================================================== */}
        <Modal
          visible={modalVisible}
          animationType="fade"
          transparent
          onRequestClose={handleCloseModal}
        >
          <View style={styles.modalOverlay}>
            <View style={[styles.modalCard, { backgroundColor: palette.card, borderColor: palette.border }]}>
              <View style={[styles.modalHeader, { borderBottomColor: palette.border }]}>
                <View style={styles.modalTitleRow}>
                  <View style={[styles.modalIconBox, { backgroundColor: palette.accentBg }]}>
                    <Feather name="file-plus" size={17} color={palette.accent} />
                  </View>
                  <View>
                    <Text style={[styles.modalTitle, { color: palette.textPrimary }]}>Tạo biên bản mới</Text>
                    <Text style={[styles.modalSubtitle, { color: palette.textSecondary }]}>
                      Nhập tiêu đề hoặc chọn gợi ý để khởi tạo phiên làm việc
                    </Text>
                  </View>
                </View>
                <Pressable onPress={handleCloseModal} hitSlop={8} style={styles.modalCloseButton}>
                  <Feather name="x" size={18} color={palette.textSecondary} />
                </Pressable>
              </View>

              {/* Suggestions */}
              <Text style={[styles.suggestionsTitle, { color: palette.textSecondary }]}>Gợi ý chủ đề:</Text>
              <View style={styles.suggestionsRow}>
                {TITLE_SUGGESTIONS.map((sug, i) => (
                  <Pressable
                    key={i}
                    onPress={() => setNewTitle(sug)}
                    style={({ pressed }) => [
                      styles.suggestionChip,
                      { backgroundColor: palette.surface, borderColor: palette.border },
                      pressed && styles.chipPressed,
                    ]}
                  >
                    <Text style={[styles.suggestionText, { color: palette.textPrimary }]}>{sug}</Text>
                  </Pressable>
                ))}
              </View>

              {/* Input */}
              <Text style={[styles.inputLabel, { color: palette.textSecondary }]}>Tiêu đề cuộc họp</Text>
              <TextInput
                value={newTitle}
                onChangeText={(t) => {
                  setNewTitle(t);
                  if (createError) setCreateError("");
                }}
                placeholder="Ví dụ: Họp giao ban công tác tuần..."
                placeholderTextColor={palette.textMuted}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={handleCreateMeeting}
                maxLength={200}
                style={[
                  styles.modalInput,
                  {
                    backgroundColor: palette.inputBg,
                    color: palette.textPrimary,
                    borderColor: createError ? "#EF4444" : newTitle.length >= 3 ? palette.accent : palette.border,
                  },
                ]}
              />

              {createError ? (
                <View style={styles.errorRow}>
                  <Feather name="alert-circle" size={13} color="#EF4444" />
                  <Text style={styles.errorRowText}>{createError}</Text>
                </View>
              ) : (
                <View style={{ height: 14 }} />
              )}

              {/* Actions */}
              <View style={styles.modalActions}>
                <Pressable
                  onPress={handleCloseModal}
                  style={({ pressed }) => [
                    styles.modalCancelButton,
                    { backgroundColor: palette.surface, borderColor: palette.border },
                    pressed && styles.buttonPressed,
                  ]}
                  disabled={isCreating}
                >
                  <Text style={[styles.modalCancelText, { color: palette.textSecondary }]}>Hủy</Text>
                </Pressable>

                <Pressable
                  onPress={handleCreateMeeting}
                  style={({ pressed }) => [
                    styles.modalSubmitButton,
                    { backgroundColor: palette.accent },
                    pressed && styles.buttonPressed,
                  ]}
                  disabled={isCreating}
                >
                  {isCreating ? (
                    <>
                      <ActivityIndicator size="small" color="#FFFFFF" style={{ marginRight: 6 }} />
                      <Text style={styles.modalSubmitText}>Đang tạo...</Text>
                    </>
                  ) : (
                    <>
                      <Feather name="arrow-right" size={15} color="#FFFFFF" style={{ marginRight: 6 }} />
                      <Text style={styles.modalSubmitText}>Tiếp tục</Text>
                    </>
                  )}
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        {/* Modal cấu hình AI Engine */}
        <AIConfigModal
          visible={aiConfigModalVisible}
          onClose={() => setAiConfigModalVisible(false)}
          onConfigUpdated={(cfg) => setAiConfig(cfg)}
        />

      </View>
    </SafeAreaView>
  );
}

// ===========================================================================
// SUB-COMPONENT: MeetingCardItem (High-Density Scannable Row)
// ===========================================================================
interface MeetingCardItemProps {
  meeting: MeetingSummary;
  cfg: { label: string; color: string; bg: string; border: string; icon: keyof typeof Feather.glyphMap };
  palette: any;
  onPress: () => void;
  onDelete: () => void;
  onDownloadDoc: () => void;
}

function MeetingCardItem({
  meeting,
  cfg,
  palette,
  onPress,
  onDelete,
  onDownloadDoc,
}: MeetingCardItemProps): React.JSX.Element {
  const [isHovered, setIsHovered] = useState(false);

  const hasTasks = typeof meeting.task_count === "number" && meeting.task_count > 0;
  const isAllTasksDone = hasTasks && meeting.completed_task_count === meeting.task_count;

  return (
    <Pressable
      onPress={onPress}
      // @ts-ignore
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={({ pressed }) => [
        cardStyles.container,
        {
          backgroundColor: isHovered ? palette.surfaceHover : palette.card,
          borderColor: isHovered ? palette.accent : palette.border,
        },
        pressed && cardStyles.containerPressed,
      ]}
    >
      {/* Icon trạng thái */}
      <View style={[cardStyles.statusIconWrapper, { backgroundColor: cfg.bg, borderColor: cfg.border }]}>
        <Feather name={cfg.icon} size={18} color={cfg.color} />
      </View>

      {/* Nội dung trung tâm */}
      <View style={cardStyles.content}>
        <Text style={[cardStyles.title, { color: palette.textPrimary }]} numberOfLines={1}>
          {meeting.title}
        </Text>

        {/* 1-Line Snippet Preview */}
        {meeting.summary_snippet ? (
          <Text style={[cardStyles.snippetText, { color: palette.textMuted }]} numberOfLines={1}>
            {meeting.summary_snippet}
          </Text>
        ) : null}

        <View style={cardStyles.metaRow}>
          {/* Badge trạng thái */}
          <View style={[cardStyles.statusBadge, { backgroundColor: cfg.bg, borderColor: cfg.border }]}>
            <View style={[cardStyles.statusDot, { backgroundColor: cfg.color }]} />
            <Text style={[cardStyles.statusText, { color: cfg.color }]}>
              {cfg.label}
            </Text>
          </View>

          {/* Mã định danh biên bản */}
          <View style={[cardStyles.codeBadge, { backgroundColor: palette.surface, borderColor: palette.border }]}>
            <Text style={[cardStyles.codeText, { color: palette.textSecondary }]}>
              #{String(meeting.id).padStart(4, "0")}/BB-CH
            </Text>
          </View>

          {/* Ngày tạo */}
          <View style={cardStyles.dateBadge}>
            <Feather name="clock" size={11} color={palette.textMuted} style={{ marginRight: 4 }} />
            <Text style={[cardStyles.dateText, { color: palette.textMuted }]}>
              {formatDate(meeting.created_at)}
            </Text>
          </View>

          {/* Mini Progress Badge nhiệm vụ */}
          {hasTasks ? (
            <View
              style={[
                cardStyles.taskBadge,
                isAllTasksDone
                  ? { backgroundColor: "rgba(16, 185, 129, 0.1)", borderColor: "rgba(16, 185, 129, 0.25)" }
                  : { backgroundColor: "rgba(37, 99, 235, 0.1)", borderColor: "rgba(37, 99, 235, 0.25)" },
              ]}
            >
              <Feather
                name={isAllTasksDone ? "check-circle" : "check-square"}
                size={11}
                color={isAllTasksDone ? "#10B981" : "#2563EB"}
                style={{ marginRight: 4 }}
              />
              <Text
                style={[
                  cardStyles.taskBadgeText,
                  { color: isAllTasksDone ? "#10B981" : "#2563EB" },
                ]}
              >
                {meeting.completed_task_count ?? 0}/{meeting.task_count} nhiệm vụ
              </Text>
            </View>
          ) : null}
        </View>
      </View>

      {/* Cụm hành động bên phải */}
      <View style={cardStyles.actionsRow}>
        {/* Nút tải nhanh file Word .doc (chỉ hiện khi đã có biên bản hoàn tất) */}
        {meeting.status === "completed" ? (
          <Pressable
            onPress={(e) => {
              e.stopPropagation?.();
              onDownloadDoc();
            }}
            hitSlop={6}
            accessibilityLabel="Tải nhanh file Word .doc"
            style={({ pressed }) => [
              cardStyles.docDownloadBtn,
              { backgroundColor: palette.surface, borderColor: palette.border },
              pressed && cardStyles.deleteButtonPressed,
            ]}
          >
            <Feather name="download" size={12} color={palette.accent} style={{ marginRight: 4 }} />
            <Text style={[cardStyles.docDownloadText, { color: palette.accent }]}>Tải .doc</Text>
          </Pressable>
        ) : null}

        <View style={[cardStyles.viewButton, { backgroundColor: palette.surface, borderColor: palette.border }]}>
          <Text style={[cardStyles.viewButtonText, { color: palette.accent }]}>
            {meeting.status === "completed" ? "Xem biên bản" : meeting.status === "processing" ? "Theo dõi" : "Ghi âm"}
          </Text>
          <Feather name="chevron-right" size={14} color={palette.accent} />
        </View>

        {/* Nút Xóa */}
        <Pressable
          onPress={(e) => {
            e.stopPropagation?.();
            onDelete();
          }}
          hitSlop={8}
          style={({ pressed }) => [
            cardStyles.deleteButton,
            { backgroundColor: palette.surface, borderColor: palette.border },
            pressed && cardStyles.deleteButtonPressed,
          ]}
        >
          <Feather name="trash-2" size={14} color="#EF4444" />
        </Pressable>
      </View>
    </Pressable>
  );
}

// ===========================================================================
// STYLESHEET
// ===========================================================================
const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  mainContainer: {
    flex: 1,
    width: "100%",
    maxWidth: 1100,
    alignSelf: "center",
    paddingHorizontal: 18,
    paddingTop: 10,
  },

  /* Header */
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 14,
    borderBottomWidth: 1,
    marginBottom: 16,
    flexWrap: "wrap",
    gap: 12,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flex: 1,
    minWidth: 260,
  },
  logoBadge: {
    width: 38,
    height: 38,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  appTitle: {
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  hybridTag: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    borderWidth: 1,
  },
  hybridTagText: {
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 0.6,
  },
  appSubtitle: {
    fontSize: 12,
    marginTop: 2,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  iconButton: {
    width: 34,
    height: 34,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  headerCtaButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  headerCtaText: {
    color: "#FFFFFF",
    fontWeight: "600",
    fontSize: 13,
  },

  /* Stats Bento Row */
  statsRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 16,
    flexWrap: "wrap",
  },
  statCard: {
    flex: 1,
    minWidth: 130,
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  statIconBox: {
    width: 32,
    height: 32,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  statNumber: {
    fontSize: 16,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  statLabel: {
    fontSize: 11,
    marginTop: 1,
  },

  /* Search & Filters */
  filterSection: {
    marginBottom: 14,
    gap: 10,
  },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    padding: 0,
  },
  filterTabs: {
    flexDirection: "row",
    gap: 6,
    flexWrap: "wrap",
  },
  filterChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
  },
  filterChipText: {
    fontSize: 12,
    fontWeight: "500",
  },
  filterChipCount: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  filterChipCountText: {
    fontSize: 10,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },

  /* List */
  listContent: {
    paddingBottom: 40,
  },

  /* Empty State */
  emptyContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 48,
    paddingHorizontal: 16,
  },
  emptyIconBox: {
    width: 64,
    height: 64,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: "600",
    marginBottom: 6,
  },
  emptySubtitle: {
    fontSize: 13,
    textAlign: "center",
    maxWidth: 380,
    lineHeight: 18,
    marginBottom: 16,
  },
  emptyCreateButton: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
  },
  emptyCreateButtonText: {
    color: "#FFFFFF",
    fontWeight: "600",
    fontSize: 13,
  },

  /* Loading & Error */
  centerContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 60,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 13,
  },
  errorIconBox: {
    width: 48,
    height: 48,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  errorTitle: {
    color: "#EF4444",
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 4,
  },
  errorMessage: {
    fontSize: 13,
    textAlign: "center",
    maxWidth: 360,
    lineHeight: 18,
    marginBottom: 14,
  },
  primaryButton: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  primaryButtonText: {
    color: "#FFFFFF",
    fontWeight: "600",
    fontSize: 13,
  },

  /* FAB */
  fabContainer: {
    position: "absolute",
    bottom: 20,
    right: 20,
  },
  fabButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
  },
  fabText: {
    color: "#FFFFFF",
    fontWeight: "600",
    fontSize: 13,
  },

  /* Modal */
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(12, 14, 18, 0.75)",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  modalCard: {
    width: "100%",
    maxWidth: 480,
    borderRadius: 10,
    padding: 18,
    borderWidth: 1,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingBottom: 14,
    marginBottom: 14,
    borderBottomWidth: 1,
  },
  modalTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  modalIconBox: {
    width: 34,
    height: 34,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  modalTitle: {
    fontSize: 15,
    fontWeight: "700",
  },
  modalSubtitle: {
    fontSize: 11,
    marginTop: 2,
  },
  modalCloseButton: {
    padding: 4,
  },
  suggestionsTitle: {
    fontSize: 11,
    fontWeight: "600",
    marginBottom: 6,
  },
  suggestionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginBottom: 14,
  },
  suggestionChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
  },
  chipPressed: {
    opacity: 0.7,
  },
  suggestionText: {
    fontSize: 11,
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 6,
  },
  modalInput: {
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 13,
    borderWidth: 1,
  },
  errorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 6,
  },
  errorRowText: {
    color: "#EF4444",
    fontSize: 12,
  },
  modalActions: {
    flexDirection: "row",
    gap: 8,
    marginTop: 6,
  },
  modalCancelButton: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 8,
    alignItems: "center",
    borderWidth: 1,
  },
  modalCancelText: {
    fontWeight: "500",
    fontSize: 13,
  },
  modalSubmitButton: {
    flex: 2,
    paddingVertical: 9,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
  },
  modalSubmitText: {
    color: "#FFFFFF",
    fontWeight: "600",
    fontSize: 13,
  },
  buttonPressed: {
    opacity: 0.8,
  },

  /* 2-Column Desktop Layout */
  workspaceRow: {
    flex: 1,
    flexDirection: Platform.OS === "web" ? "row" : "column",
    gap: 18,
  },
  mainColumn: {
    flex: 1,
    minWidth: 0,
  },
  sidebarCol: {
    width: 320,
    gap: 14,
    flexShrink: 0,
  },
  sidebarCard: {
    borderRadius: 8,
    borderWidth: 1,
    padding: 14,
    gap: 12,
  },
  sidebarCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  sidebarCardIcon: {
    width: 30,
    height: 30,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  sidebarCardTitle: {
    fontSize: 13,
    fontWeight: "600",
  },
  sidebarCardSub: {
    fontSize: 11,
    marginTop: 1,
  },
  dropzoneBox: {
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: 8,
    padding: 18,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  dropzoneTitle: {
    fontSize: 12,
    fontWeight: "600",
  },
  dropzoneHint: {
    fontSize: 11,
    textAlign: "center",
  },
  sidebarLoadingBox: {
    paddingVertical: 20,
    alignItems: "center",
  },
  emptyTasksBox: {
    paddingVertical: 18,
    alignItems: "center",
    gap: 6,
  },
  emptyTasksText: {
    fontSize: 11,
    textAlign: "center",
  },
  taskItemCard: {
    borderRadius: 6,
    borderWidth: 1,
    padding: 9,
    gap: 5,
  },
  taskItemHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
  },
  taskStatusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginTop: 5,
    flexShrink: 0,
  },
  taskItemTitle: {
    fontSize: 12,
    fontWeight: "500",
    flex: 1,
    lineHeight: 16,
  },
  taskItemMeta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: 12,
  },
  taskMeetingCode: {
    fontSize: 10,
    fontWeight: "600",
  },
  taskDueDate: {
    fontSize: 10,
  },
});

/* Card Styles */
const cardStyles = StyleSheet.create({
  container: {
    width: "100%",
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  containerPressed: {
    opacity: 0.85,
  },
  statusIconWrapper: {
    width: 38,
    height: 38,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  content: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 4,
  },
  snippetText: {
    fontSize: 11,
    fontStyle: "italic",
    marginBottom: 6,
    lineHeight: 15,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
  },
  statusDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  statusText: {
    fontSize: 10,
    fontWeight: "600",
  },
  codeBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
    borderWidth: 1,
  },
  codeText: {
    fontSize: 10,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  taskBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
  },
  taskBadgeText: {
    fontSize: 10,
    fontWeight: "600",
  },
  dateBadge: {
    flexDirection: "row",
    alignItems: "center",
  },
  dateText: {
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  },
  actionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 0,
  },
  docDownloadBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
  },
  docDownloadText: {
    fontSize: 11,
    fontWeight: "600",
  },
  viewButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
  },
  viewButtonText: {
    fontSize: 11,
    fontWeight: "600",
  },
  deleteButton: {
    width: 30,
    height: 30,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  deleteButtonPressed: {
    backgroundColor: "rgba(239, 68, 68, 0.15)",
  },
});
