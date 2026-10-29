/**
 * src/screens/HomeScreen.tsx
 *
 * Executive Dashboard – VietMeeting AI
 * Modern AI SaaS Dashboard (phong cách Otter.ai / Notion / Linear)
 * Dark Deep Space theme, responsive chuẩn trên Web & Mobile
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
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
import { Ionicons } from "@expo/vector-icons";
import axios, { AxiosError } from "axios";

import { API_ENDPOINTS, API_TIMEOUT_SHORT_MS, BASE_URL } from "@/constants/api";
import { AIEngineBadge, AIConfigModal } from "@/components/AIConfigModal";
import type {
  APIErrorResponse,
  MeetingCreateBody,
  MeetingSummary,
  MeetingStatus,
  RootStackParamList,
} from "@/types/meeting";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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

/** Cấu hình trạng thái cuộc họp */
const STATUS_CONFIG: Record<
  MeetingStatus,
  { label: string; color: string; bg: string; border: string; icon: keyof typeof Ionicons.glyphMap }
> = {
  created: {
    label: "Chưa ghi âm",
    color: "#38bdf8",
    bg: "rgba(56, 189, 248, 0.12)",
    border: "rgba(56, 189, 248, 0.3)",
    icon: "mic-outline",
  },
  processing: {
    label: "Đang xử lý AI",
    color: "#fbbf24",
    bg: "rgba(251, 191, 36, 0.12)",
    border: "rgba(251, 191, 36, 0.3)",
    icon: "sync-outline",
  },
  completed: {
    label: "Đã hoàn thành",
    color: "#34d399",
    bg: "rgba(52, 211, 153, 0.12)",
    border: "rgba(52, 211, 153, 0.3)",
    icon: "checkmark-circle",
  },
  failed: {
    label: "Thất bại",
    color: "#f87171",
    bg: "rgba(248, 113, 113, 0.12)",
    border: "rgba(248, 113, 113, 0.3)",
    icon: "alert-circle",
  },
};

// Gợi ý tên cuộc họp nhanh
const TITLE_SUGGESTIONS = [
  "Họp kế hoạch tuần",
  "Đánh giá tiến độ dự án AI",
  "Thảo luận kiến trúc hệ thống",
  "Họp giao ban định kỳ",
];

// ===========================================================================
// COMPONENT CHÍNH
// ===========================================================================
export default function HomeScreen(): React.JSX.Element {
  const navigation = useNavigation<NavProp>();

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

  // Animation
  const fabScale = useRef(new Animated.Value(1)).current;

  // -------------------------------------------------------------------------
  // Fetch danh sách meetings
  // -------------------------------------------------------------------------
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
  }, [fetchMeetings]);

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

  // -------------------------------------------------------------------------
  // Tạo meeting mới
  // -------------------------------------------------------------------------
  const handleCreateMeeting = async () => {
    const trimmedTitle = newTitle.trim();
    if (trimmedTitle.length < 3) {
      setCreateError("Tên cuộc họp phải có ít nhất 3 ký tự.");
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
          msg = "Mất kết nối Backend.";
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

  // -------------------------------------------------------------------------
  // Xóa cuộc họp
  // -------------------------------------------------------------------------
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
      if (window.confirm(`Bạn có chắc muốn xóa vĩnh viễn "${meeting.title}"?`)) {
        proceedDelete();
      }
    } else {
      Alert.alert(
        "Xóa cuộc họp",
        `Bạn có chắc muốn xóa "${meeting.title}"?\nHành động này không thể hoàn tác.`,
        [
          { text: "Huỷ", style: "cancel" },
          { text: "Xóa", style: "destructive", onPress: proceedDelete },
        ]
      );
    }
  };

  // -------------------------------------------------------------------------
  // Navigate sang Recording
  // -------------------------------------------------------------------------
  const handleMeetingPress = (meeting: MeetingSummary) => {
    navigation.navigate("Recording", {
      meetingId: meeting.id,
      meetingTitle: meeting.title,
      meetingStatus: meeting.status,
    });
  };

  // =========================================================================
  // RENDER
  // =========================================================================
  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#090D16" />
      <View style={styles.mainContainer}>

        {/* ==================================================================
            HEADER
        ================================================================== */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <View style={styles.logoBadge}>
              <Ionicons name="sparkles" size={20} color="#818cf8" />
            </View>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={styles.appTitle}>VietMeeting AI</Text>
                <View style={styles.aiTag}>
                  <Text style={styles.aiTagText}>LOCAL AI 100%</Text>
                </View>
              </View>
              <Text style={styles.appSubtitle}>
                Trợ lý ghi âm, tạo biên bản & trích xuất công việc thông minh
              </Text>
            </View>
          </View>

          <View style={styles.headerRight}>
            {/* Engine Status Badge (bấm vào mở Modal Cấu hình AI) */}
            <AIEngineBadge onPress={() => setAiConfigModalVisible(true)} />

            <Pressable
              onPress={() => fetchMeetings(true)}
              style={({ pressed }) => [styles.iconButton, pressed && styles.buttonPressed]}
            >
              <Ionicons name="refresh" size={18} color="#94a3b8" />
            </Pressable>

            <Pressable
              onPress={handleOpenModal}
              style={({ pressed }) => [styles.headerCtaButton, pressed && styles.buttonPressed]}
            >
              <Ionicons name="add-circle" size={18} color="#ffffff" />
              <Text style={styles.headerCtaText}>Tạo cuộc họp mới</Text>
            </Pressable>
          </View>
        </View>

        {/* ==================================================================
            BENTO KPI CARDS
        ================================================================== */}
        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <View style={[styles.statIconBox, { backgroundColor: "rgba(99, 102, 241, 0.15)" }]}>
              <Ionicons name="folder-open" size={18} color="#818cf8" />
            </View>
            <View>
              <Text style={styles.statNumber}>{stats.total}</Text>
              <Text style={styles.statLabel}>Tổng cuộc họp</Text>
            </View>
          </View>

          <View style={styles.statCard}>
            <View style={[styles.statIconBox, { backgroundColor: "rgba(52, 211, 153, 0.15)" }]}>
              <Ionicons name="checkmark-done" size={18} color="#34d399" />
            </View>
            <View>
              <Text style={styles.statNumber}>{stats.completed}</Text>
              <Text style={styles.statLabel}>Đã có biên bản</Text>
            </View>
          </View>

          <View style={styles.statCard}>
            <View style={[styles.statIconBox, { backgroundColor: "rgba(56, 189, 248, 0.15)" }]}>
              <Ionicons name="shield-checkmark" size={18} color="#38bdf8" />
            </View>
            <View>
              <Text style={styles.statNumber}>100%</Text>
              <Text style={styles.statLabel}>Offline Local</Text>
            </View>
          </View>

          <View style={styles.statCard}>
            <View style={[styles.statIconBox, { backgroundColor: "rgba(251, 191, 36, 0.15)" }]}>
              <Ionicons name="time" size={18} color="#fbbf24" />
            </View>
            <View>
              <Text style={styles.statNumber}>60+</Text>
              <Text style={styles.statLabel}>Phút / file</Text>
            </View>
          </View>
        </View>

        {/* ==================================================================
            TÌM KIẾM VÀ BỘ LỌC
        ================================================================== */}
        <View style={styles.filterSection}>
          <View style={styles.searchBar}>
            <Ionicons name="search" size={16} color="#64748b" style={{ marginRight: 8 }} />
            <TextInput
              style={styles.searchInput}
              placeholder="Tìm kiếm theo tiêu đề cuộc họp..."
              placeholderTextColor="#64748b"
              value={searchQuery}
              onChangeText={setSearchQuery}
            />
            {searchQuery.length > 0 && (
              <Pressable onPress={() => setSearchQuery("")} hitSlop={8}>
                <Ionicons name="close-circle" size={16} color="#64748b" />
              </Pressable>
            )}
          </View>

          <View style={styles.filterTabs}>
            {[
              { id: "all", label: "Tất cả", count: stats.total },
              { id: "completed", label: "Đã xong", count: stats.completed },
              { id: "created", label: "Chưa ghi", count: stats.pending },
              { id: "processing", label: "Đang xử lý", count: stats.processing },
            ].map((tab) => {
              const active = statusFilter === tab.id;
              return (
                <Pressable
                  key={tab.id}
                  onPress={() => setStatusFilter(tab.id)}
                  style={[styles.filterChip, active && styles.filterChipActive]}
                >
                  <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                    {tab.label}
                  </Text>
                  <View style={[styles.filterChipCount, active && styles.filterChipCountActive]}>
                    <Text style={[styles.filterChipCountText, active && styles.filterChipCountTextActive]}>
                      {tab.count}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* ==================================================================
            DANH SÁCH CUỘC HỌP
        ================================================================== */}
        {isLoading ? (
          <View style={styles.centerContainer}>
            <ActivityIndicator size="large" color="#6366f1" />
            <Text style={styles.loadingText}>Đang tải danh sách cuộc họp...</Text>
          </View>
        ) : loadError ? (
          <View style={styles.centerContainer}>
            <View style={styles.errorIconBox}>
              <Ionicons name="wifi-outline" size={32} color="#f87171" />
            </View>
            <Text style={styles.errorTitle}>Lỗi kết nối</Text>
            <Text style={styles.errorMessage}>{loadError}</Text>
            <Pressable
              onPress={() => fetchMeetings()}
              style={({ pressed }) => [styles.primaryButton, pressed && styles.buttonPressed]}
            >
              <Ionicons name="reload" size={16} color="#fff" style={{ marginRight: 6 }} />
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
                onRefresh={() => fetchMeetings(true)}
                tintColor="#6366f1"
                colors={["#6366f1"]}
              />
            }
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                <View style={styles.emptyIconBox}>
                  <Ionicons name="document-text-outline" size={44} color="#475569" />
                </View>
                <Text style={styles.emptyTitle}>
                  {searchQuery || statusFilter !== "all"
                    ? "Không tìm thấy cuộc họp phù hợp"
                    : "Chưa có cuộc họp nào"}
                </Text>
                <Text style={styles.emptySubtitle}>
                  {searchQuery || statusFilter !== "all"
                    ? "Hãy thử tìm với từ khoá khác hoặc đặt lại bộ lọc."
                    : "Tạo cuộc họp mới để bắt đầu ghi âm và trích xuất biên bản tự động với Local AI."}
                </Text>
                <Pressable
                  onPress={handleOpenModal}
                  style={({ pressed }) => [styles.emptyCreateButton, pressed && styles.buttonPressed]}
                >
                  <Ionicons name="add-circle" size={18} color="#fff" style={{ marginRight: 8 }} />
                  <Text style={styles.emptyCreateButtonText}>Tạo cuộc họp đầu tiên</Text>
                </Pressable>
              </View>
            }
            renderItem={({ item }) => (
              <MeetingCard
                meeting={item}
                onPress={() => handleMeetingPress(item)}
                onDelete={() => handleDeleteMeeting(item)}
              />
            )}
            ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          />
        )}

        {/* ==================================================================
            FAB NÚT NỔI TẠO CUỘC HỌP (CHO MOBILE)
        ================================================================== */}
        {Platform.OS !== "web" && (
          <Animated.View style={[styles.fabContainer, { transform: [{ scale: fabScale }] }]}>
            <Pressable
              onPress={handleOpenModal}
              style={({ pressed }) => [styles.fabButton, pressed && styles.buttonPressed]}
            >
              <Ionicons name="add" size={24} color="#fff" />
              <Text style={styles.fabText}>Cuộc họp mới</Text>
            </Pressable>
          </Animated.View>
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
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <View style={styles.modalTitleRow}>
                  <View style={styles.modalIconBox}>
                    <Ionicons name="mic" size={20} color="#818cf8" />
                  </View>
                  <View>
                    <Text style={styles.modalTitle}>Tạo cuộc họp mới</Text>
                    <Text style={styles.modalSubtitle}>Nhập chủ đề hoặc tiêu đề để dễ theo dõi</Text>
                  </View>
                </View>
                <Pressable onPress={handleCloseModal} hitSlop={8} style={styles.modalCloseButton}>
                  <Ionicons name="close" size={20} color="#94a3b8" />
                </Pressable>
              </View>

              {/* Suggestions */}
              <Text style={styles.suggestionsTitle}>Gợi ý nhanh:</Text>
              <View style={styles.suggestionsRow}>
                {TITLE_SUGGESTIONS.map((sug, i) => (
                  <Pressable
                    key={i}
                    onPress={() => setNewTitle(sug)}
                    style={({ pressed }) => [styles.suggestionChip, pressed && styles.chipPressed]}
                  >
                    <Text style={styles.suggestionText}>{sug}</Text>
                  </Pressable>
                ))}
              </View>

              {/* Input */}
              <Text style={styles.inputLabel}>Tiêu đề cuộc họp</Text>
              <TextInput
                value={newTitle}
                onChangeText={(t) => {
                  setNewTitle(t);
                  if (createError) setCreateError("");
                }}
                placeholder="Ví dụ: Họp chiến lược sản phẩm Q4/2026..."
                placeholderTextColor="#475569"
                autoFocus
                returnKeyType="done"
                onSubmitEditing={handleCreateMeeting}
                maxLength={200}
                style={[
                  styles.modalInput,
                  createError ? styles.modalInputError : newTitle.length >= 3 ? styles.modalInputActive : null,
                ]}
              />

              {createError ? (
                <View style={styles.errorRow}>
                  <Ionicons name="alert-circle" size={14} color="#f87171" />
                  <Text style={styles.errorRowText}>{createError}</Text>
                </View>
              ) : (
                <View style={{ height: 16 }} />
              )}

              {/* Action Buttons */}
              <View style={styles.modalActions}>
                <Pressable
                  onPress={handleCloseModal}
                  style={({ pressed }) => [styles.modalCancelButton, pressed && styles.buttonPressed]}
                  disabled={isCreating}
                >
                  <Text style={styles.modalCancelText}>Hủy</Text>
                </Pressable>

                <Pressable
                  onPress={handleCreateMeeting}
                  style={({ pressed }) => [styles.modalSubmitButton, pressed && styles.buttonPressed]}
                  disabled={isCreating}
                >
                  {isCreating ? (
                    <>
                      <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
                      <Text style={styles.modalSubmitText}>Đang tạo...</Text>
                    </>
                  ) : (
                    <>
                      <Ionicons name="arrow-forward" size={18} color="#fff" style={{ marginRight: 6 }} />
                      <Text style={styles.modalSubmitText}>Bắt đầu ngay</Text>
                    </>
                  )}
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        {/* Modal cấu hình AI Engine (Gemini & Local) */}
        <AIConfigModal
          visible={aiConfigModalVisible}
          onClose={() => setAiConfigModalVisible(false)}
        />

      </View>
    </SafeAreaView>
  );
}

// ===========================================================================
// SUB-COMPONENT: MeetingCard
// ===========================================================================
interface MeetingCardProps {
  meeting: MeetingSummary;
  onPress: () => void;
  onDelete: () => void;
}

function MeetingCard({ meeting, onPress, onDelete }: MeetingCardProps): React.JSX.Element {
  const cfg = STATUS_CONFIG[meeting.status] ?? STATUS_CONFIG.created;
  const [isHovered, setIsHovered] = useState(false);

  return (
    <Pressable
      onPress={onPress}
      // @ts-ignore onMouseEnter & onMouseLeave cho web
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={({ pressed }) => [
        cardStyles.container,
        isHovered && cardStyles.containerHovered,
        pressed && cardStyles.containerPressed,
      ]}
    >
      {/* Icon trạng thái */}
      <View style={[cardStyles.statusIconWrapper, { backgroundColor: cfg.bg, borderColor: cfg.border }]}>
        <Ionicons name={cfg.icon} size={22} color={cfg.color} />
      </View>

      {/* Nội dung trung tâm */}
      <View style={cardStyles.content}>
        <View style={cardStyles.titleRow}>
          <Text style={cardStyles.title} numberOfLines={1}>
            {meeting.title}
          </Text>
        </View>

        <View style={cardStyles.metaRow}>
          {/* Badge trạng thái */}
          <View style={[cardStyles.statusBadge, { backgroundColor: cfg.bg, borderColor: cfg.border }]}>
            <View style={[cardStyles.statusDot, { backgroundColor: cfg.color }]} />
            <Text style={[cardStyles.statusText, { color: cfg.color }]}>
              {cfg.label}
            </Text>
          </View>

          {/* Ngày tạo */}
          <View style={cardStyles.dateBadge}>
            <Ionicons name="time-outline" size={12} color="#64748b" style={{ marginRight: 4 }} />
            <Text style={cardStyles.dateText}>{formatDate(meeting.created_at)}</Text>
          </View>
        </View>
      </View>

      {/* Cụm hành động bên phải */}
      <View style={cardStyles.actionsRow}>
        <View style={cardStyles.viewButton}>
          <Text style={cardStyles.viewButtonText}>
            {meeting.status === "completed" ? "Xem kết quả" : meeting.status === "processing" ? "Theo dõi" : "Ghi âm"}
          </Text>
          <Ionicons name="chevron-forward" size={16} color="#818cf8" />
        </View>

        {/* Nút Xóa */}
        <Pressable
          onPress={(e) => {
            e.stopPropagation?.();
            onDelete();
          }}
          hitSlop={10}
          style={({ pressed }) => [cardStyles.deleteButton, pressed && cardStyles.deleteButtonPressed]}
        >
          <Ionicons name="trash-outline" size={16} color="#f87171" />
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
    backgroundColor: "#090D16",
  },
  mainContainer: {
    flex: 1,
    width: "100%",
    maxWidth: 1120,
    alignSelf: "center",
    paddingHorizontal: 20,
    paddingTop: 12,
  },

  /* Header */
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255, 255, 255, 0.06)",
    marginBottom: 18,
    flexWrap: "wrap",
    gap: 12,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    flex: 1,
    minWidth: 280,
  },
  logoBadge: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: "rgba(99, 102, 241, 0.16)",
    borderWidth: 1,
    borderColor: "rgba(99, 102, 241, 0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  appTitle: {
    color: "#f8fafc",
    fontSize: 22,
    fontWeight: "800",
    letterSpacing: -0.5,
  },
  aiTag: {
    backgroundColor: "rgba(99, 102, 241, 0.2)",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "rgba(129, 140, 248, 0.4)",
  },
  aiTagText: {
    color: "#a5b4fc",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  appSubtitle: {
    color: "#94a3b8",
    fontSize: 13,
    marginTop: 2,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
  },
  engineBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(52, 211, 153, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(52, 211, 153, 0.25)",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
  },
  engineDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: "#34d399",
    shadowColor: "#34d399",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 6,
  },
  engineText: {
    color: "#86efac",
    fontSize: 11,
    fontWeight: "600",
  },
  iconButton: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: "#111827",
    borderWidth: 1,
    borderColor: "#1e293b",
    alignItems: "center",
    justifyContent: "center",
  },
  headerCtaButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#4f46e5",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    shadowColor: "#6366f1",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
  },
  headerCtaText: {
    color: "#ffffff",
    fontWeight: "700",
    fontSize: 14,
  },

  /* Stats Dashboard */
  statsRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 18,
    flexWrap: "wrap",
  },
  statCard: {
    flex: 1,
    minWidth: 140,
    backgroundColor: "#111827",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  statIconBox: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  statNumber: {
    color: "#f8fafc",
    fontSize: 18,
    fontWeight: "800",
  },
  statLabel: {
    color: "#64748b",
    fontSize: 12,
    marginTop: 1,
  },

  /* Search & Filters */
  filterSection: {
    marginBottom: 16,
    gap: 12,
  },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#111827",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "#1e293b",
  },
  searchInput: {
    flex: 1,
    color: "#f8fafc",
    fontSize: 14,
    padding: 0,
  },
  filterTabs: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
  },
  filterChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: "#111827",
    borderWidth: 1,
    borderColor: "#1e293b",
  },
  filterChipActive: {
    backgroundColor: "rgba(99, 102, 241, 0.2)",
    borderColor: "#6366f1",
  },
  filterChipText: {
    color: "#94a3b8",
    fontSize: 13,
    fontWeight: "500",
  },
  filterChipTextActive: {
    color: "#a5b4fc",
    fontWeight: "700",
  },
  filterChipCount: {
    backgroundColor: "#1e293b",
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 10,
  },
  filterChipCountActive: {
    backgroundColor: "#6366f1",
  },
  filterChipCountText: {
    color: "#64748b",
    fontSize: 11,
    fontWeight: "600",
  },
  filterChipCountTextActive: {
    color: "#ffffff",
  },

  /* List */
  listContent: {
    paddingBottom: 60,
  },

  /* Empty State */
  emptyContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 60,
    paddingHorizontal: 20,
  },
  emptyIconBox: {
    width: 80,
    height: 80,
    borderRadius: 24,
    backgroundColor: "#111827",
    borderWidth: 1,
    borderColor: "#1e293b",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  emptyTitle: {
    color: "#f8fafc",
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 8,
  },
  emptySubtitle: {
    color: "#64748b",
    fontSize: 14,
    textAlign: "center",
    maxWidth: 420,
    lineHeight: 22,
    marginBottom: 20,
  },
  emptyCreateButton: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#4f46e5",
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 14,
  },
  emptyCreateButtonText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 14,
  },

  /* Loading & Error */
  centerContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 80,
  },
  loadingText: {
    color: "#94a3b8",
    marginTop: 14,
    fontSize: 14,
  },
  errorIconBox: {
    width: 60,
    height: 60,
    borderRadius: 18,
    backgroundColor: "rgba(248, 113, 113, 0.12)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  errorTitle: {
    color: "#f87171",
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 6,
  },
  errorMessage: {
    color: "#94a3b8",
    fontSize: 14,
    textAlign: "center",
    maxWidth: 380,
    lineHeight: 20,
    marginBottom: 16,
  },
  primaryButton: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#4f46e5",
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 12,
  },
  primaryButtonText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 14,
  },

  /* FAB */
  fabContainer: {
    position: "absolute",
    bottom: 24,
    right: 24,
  },
  fabButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#4f46e5",
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: 24,
    shadowColor: "#6366f1",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.5,
    shadowRadius: 14,
  },
  fabText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 15,
  },

  /* Modal */
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(4, 7, 15, 0.82)",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  modalCard: {
    width: "100%",
    maxWidth: 520,
    backgroundColor: "#111827",
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.1)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 20 },
    shadowOpacity: 0.6,
    shadowRadius: 30,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: 18,
  },
  modalTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  modalIconBox: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "rgba(99, 102, 241, 0.16)",
    alignItems: "center",
    justifyContent: "center",
  },
  modalTitle: {
    color: "#f8fafc",
    fontSize: 18,
    fontWeight: "800",
  },
  modalSubtitle: {
    color: "#64748b",
    fontSize: 12,
    marginTop: 2,
  },
  modalCloseButton: {
    padding: 4,
  },
  suggestionsTitle: {
    color: "#94a3b8",
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 8,
  },
  suggestionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 18,
  },
  suggestionChip: {
    backgroundColor: "#1E293B",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#334155",
  },
  chipPressed: {
    backgroundColor: "#334155",
  },
  suggestionText: {
    color: "#a5b4fc",
    fontSize: 12,
  },
  inputLabel: {
    color: "#cbd5e1",
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 6,
  },
  modalInput: {
    backgroundColor: "#0F172A",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: "#f8fafc",
    fontSize: 15,
    borderWidth: 1,
    borderColor: "#334155",
  },
  modalInputActive: {
    borderColor: "#6366f1",
  },
  modalInputError: {
    borderColor: "#f87171",
  },
  errorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 8,
  },
  errorRowText: {
    color: "#f87171",
    fontSize: 12,
  },
  modalActions: {
    flexDirection: "row",
    gap: 12,
    marginTop: 10,
  },
  modalCancelButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: "#1E293B",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#334155",
  },
  modalCancelText: {
    color: "#94a3b8",
    fontWeight: "600",
    fontSize: 14,
  },
  modalSubmitButton: {
    flex: 2,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: "#4f46e5",
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
  },
  modalSubmitText: {
    color: "#ffffff",
    fontWeight: "700",
    fontSize: 14,
  },

  buttonPressed: {
    opacity: 0.8,
  },
});

/* Card Styles */
const cardStyles = StyleSheet.create({
  container: {
    width: "100%",
    backgroundColor: "#111827",
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.07)",
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  containerHovered: {
    backgroundColor: "#1E293B",
    borderColor: "rgba(99, 102, 241, 0.4)",
    transform: [{ translateY: -2 }],
    shadowColor: "#6366f1",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.15,
    shadowRadius: 14,
  },
  containerPressed: {
    opacity: 0.85,
  },
  statusIconWrapper: {
    width: 48,
    height: 48,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  content: {
    flex: 1,
    minWidth: 0,
  },
  titleRow: {
    marginBottom: 6,
  },
  title: {
    color: "#f8fafc",
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: -0.2,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    fontSize: 11,
    fontWeight: "700",
  },
  dateBadge: {
    flexDirection: "row",
    alignItems: "center",
  },
  dateText: {
    color: "#64748b",
    fontSize: 12,
  },

  /* Actions */
  actionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flexShrink: 0,
  },
  viewButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "rgba(99, 102, 241, 0.12)",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(99, 102, 241, 0.25)",
  },
  viewButtonText: {
    color: "#a5b4fc",
    fontSize: 12,
    fontWeight: "700",
  },
  deleteButton: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: "#1E293B",
    borderWidth: 1,
    borderColor: "#334155",
    alignItems: "center",
    justifyContent: "center",
  },
  deleteButtonPressed: {
    backgroundColor: "rgba(248, 113, 113, 0.2)",
    borderColor: "#f87171",
  },
});
