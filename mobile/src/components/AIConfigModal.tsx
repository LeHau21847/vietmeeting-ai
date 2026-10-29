/**
 * src/components/AIConfigModal.tsx
 *
 * Modal cấu hình nhanh Google Gemini API Key & AI Engine Switcher (Hybrid AI).
 * Tích hợp huy hiệu trạng thái AI Engine trên Header.
 */

import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Clipboard,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import axios from "axios";

import { API_ENDPOINTS, API_TIMEOUT_SHORT_MS } from "@/constants/api";
import type { AIConfigData } from "@/types/meeting";

interface AIConfigModalProps {
  visible: boolean;
  onClose: () => void;
  onConfigUpdated?: (config: AIConfigData) => void;
}

export function AIConfigModal({
  visible,
  onClose,
  onConfigUpdated,
}: AIConfigModalProps): React.JSX.Element {
  const [config, setConfig] = useState<AIConfigData | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [preferredEngine, setPreferredEngine] = useState<"gemini" | "local">("gemini");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  // Tải cấu hình hiện tại khi modal mở
  useEffect(() => {
    if (visible) {
      fetchConfig();
      setSaveSuccess(false);
      setErrorMsg("");
    }
  }, [visible]);

  const fetchConfig = async () => {
    setIsLoading(true);
    try {
      const res = await axios.get<AIConfigData>(API_ENDPOINTS.aiConfig, {
        timeout: API_TIMEOUT_SHORT_MS,
      });
      setConfig(res.data);
      setPreferredEngine(res.data.preferred_engine);
    } catch {
      setErrorMsg("Không thể kết nối đến Backend để kiểm tra cấu hình AI.");
    } finally {
      setIsLoading(false);
    }
  };

  const handlePasteClipboard = async () => {
    try {
      if (Platform.OS === "web") {
        const text = await navigator.clipboard.readText();
        if (text) setApiKeyInput(text.trim());
      } else {
        const text = await Clipboard.getString();
        if (text) setApiKeyInput(text.trim());
      }
    } catch {
      // ignore
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setErrorMsg("");
    setSaveSuccess(false);

    try {
      const payload: { gemini_api_key?: string; preferred_engine: "gemini" | "local" } = {
        preferred_engine: preferredEngine,
      };

      if (apiKeyInput.trim()) {
        payload.gemini_api_key = apiKeyInput.trim();
      }

      const res = await axios.post<AIConfigData>(API_ENDPOINTS.aiConfig, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: API_TIMEOUT_SHORT_MS,
      });

      setConfig(res.data);
      setApiKeyInput("");
      setSaveSuccess(true);
      if (onConfigUpdated) {
        onConfigUpdated(res.data);
      }
      setTimeout(() => {
        setSaveSuccess(false);
        onClose();
      }, 1200);
    } catch (err: any) {
      setErrorMsg(err?.response?.data?.message || "Lỗi khi lưu cấu hình AI.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <View style={styles.modalCard}>
          {/* Header */}
          <View style={styles.headerRow}>
            <View style={styles.headerLeft}>
              <View style={styles.iconBox}>
                <Ionicons name="sparkles" size={20} color="#a855f7" />
              </View>
              <View>
                <Text style={styles.title}>Cấu hình AI Engine</Text>
                <Text style={styles.subTitle}>Google Gemini Cloud & Local AI</Text>
              </View>
            </View>
            <Pressable onPress={onClose} style={styles.closeBtn}>
              <Ionicons name="close" size={20} color="#94a3b8" />
            </Pressable>
          </View>

          {isLoading ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator size="large" color="#a855f7" />
              <Text style={styles.loadingText}>Đang đọc cấu hình hệ thống...</Text>
            </View>
          ) : (
            <View style={styles.body}>
              {/* Trạng thái hiện tại */}
              <View style={styles.statusBox}>
                <View style={styles.statusRow}>
                  <Text style={styles.statusLabel}>Engine đang hoạt động:</Text>
                  <View
                    style={[
                      styles.engineTag,
                      config?.active_engine === "gemini"
                        ? styles.engineTagGemini
                        : styles.engineTagLocal,
                    ]}
                  >
                    <Ionicons
                      name={config?.active_engine === "gemini" ? "sparkles" : "hardware-chip-outline"}
                      size={13}
                      color={config?.active_engine === "gemini" ? "#c084fc" : "#38bdf8"}
                      style={{ marginRight: 4 }}
                    />
                    <Text
                      style={[
                        styles.engineTagText,
                        config?.active_engine === "gemini"
                          ? { color: "#e9d5ff" }
                          : { color: "#bae6fd" },
                      ]}
                    >
                      {config?.active_engine === "gemini"
                        ? "Google Gemini Pro AI (99%)"
                        : "Local Offline AI"}
                    </Text>
                  </View>
                </View>

                {config?.has_gemini_key ? (
                  <View style={styles.keyRow}>
                    <Ionicons name="key-outline" size={14} color="#34d399" />
                    <Text style={styles.keyActiveText}>
                      API Key đã nạp:{" "}
                      <Text style={{ fontWeight: "700", color: "#6ee7b7" }}>
                        {config.gemini_api_key_masked}
                      </Text>
                    </Text>
                  </View>
                ) : (
                  <View style={styles.keyRow}>
                    <Ionicons name="alert-circle-outline" size={14} color="#fbbf24" />
                    <Text style={styles.keyMissingText}>
                      Chưa cấu hình Gemini API Key. Đang dùng Local AI.
                    </Text>
                  </View>
                )}
              </View>

              {/* Lựa chọn Engine ưu tiên */}
              <Text style={styles.sectionLabel}>CHẾ ĐỘ XỬ LÝ ƯU TIÊN</Text>
              <View style={styles.engineChoiceRow}>
                {/* Option Gemini */}
                <Pressable
                  onPress={() => setPreferredEngine("gemini")}
                  style={[
                    styles.choiceCard,
                    preferredEngine === "gemini" && styles.choiceCardActiveGemini,
                  ]}
                >
                  <View style={styles.choiceHeader}>
                    <Ionicons
                      name="sparkles"
                      size={18}
                      color={preferredEngine === "gemini" ? "#c084fc" : "#64748b"}
                    />
                    <View
                      style={[
                        styles.radioDot,
                        preferredEngine === "gemini" && styles.radioDotActiveGemini,
                      ]}
                    />
                  </View>
                  <Text style={styles.choiceTitle}>Google Gemini AI</Text>
                  <Text style={styles.choiceDesc}>
                    Chính xác 99%, nhanh, không tốn VRAM. Tối ưu gỡ băng & tạo biên bản chuẩn.
                  </Text>
                </Pressable>

                {/* Option Local */}
                <Pressable
                  onPress={() => setPreferredEngine("local")}
                  style={[
                    styles.choiceCard,
                    preferredEngine === "local" && styles.choiceCardActiveLocal,
                  ]}
                >
                  <View style={styles.choiceHeader}>
                    <Ionicons
                      name="shield-checkmark"
                      size={18}
                      color={preferredEngine === "local" ? "#38bdf8" : "#64748b"}
                    />
                    <View
                      style={[
                        styles.radioDot,
                        preferredEngine === "local" && styles.radioDotActiveLocal,
                      ]}
                    />
                  </View>
                  <Text style={styles.choiceTitle}>Local Offline AI</Text>
                  <Text style={styles.choiceDesc}>
                    Hoạt động 100% nội bộ không cần Internet (Whisper + Ollama Qwen2.5).
                  </Text>
                </Pressable>
              </View>

              {/* Nhập/Cập nhật API Key */}
              <View style={styles.inputSection}>
                <View style={styles.inputHeaderRow}>
                  <Text style={styles.sectionLabel}>GOOGLE GEMINI API KEY</Text>
                  <Pressable onPress={handlePasteClipboard} style={styles.pasteBtn}>
                    <Ionicons name="clipboard-outline" size={13} color="#a855f7" />
                    <Text style={styles.pasteBtnText}>Dán từ Clipboard</Text>
                  </Pressable>
                </View>

                <TextInput
                  value={apiKeyInput}
                  onChangeText={setApiKeyInput}
                  placeholder={
                    config?.has_gemini_key
                      ? "Nhập key mới nếu muốn đổi (hoặc để trống giữ nguyên)"
                      : "Dán Google Gemini API Key tại đây..."
                  }
                  placeholderTextColor="#64748b"
                  style={styles.keyInput}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry={false}
                />
                <Text style={styles.inputHint}>
                  💡 Key được lưu an toàn vào file <Text style={{ color: "#a855f7" }}>.env</Text> và biến môi trường server.
                </Text>
              </View>

              {/* Thông báo lỗi nếu có */}
              {errorMsg ? (
                <View style={styles.errBanner}>
                  <Ionicons name="alert-circle" size={16} color="#f87171" />
                  <Text style={styles.errBannerText}>{errorMsg}</Text>
                </View>
              ) : null}

              {/* Thông báo thành công */}
              {saveSuccess ? (
                <View style={styles.successBanner}>
                  <Ionicons name="checkmark-circle" size={16} color="#34d399" />
                  <Text style={styles.successBannerText}>Đã cập nhật cấu hình AI thành công!</Text>
                </View>
              ) : null}

              {/* Nút lưu */}
              <View style={styles.btnRow}>
                <Pressable onPress={onClose} style={styles.cancelBtn}>
                  <Text style={styles.cancelBtnText}>Đóng</Text>
                </Pressable>

                <Pressable
                  onPress={handleSave}
                  disabled={isSaving}
                  style={[styles.saveBtn, isSaving && { opacity: 0.6 }]}
                >
                  {isSaving ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <>
                      <Ionicons name="save-outline" size={16} color="#fff" style={{ marginRight: 6 }} />
                      <Text style={styles.saveBtnText}>Lưu cấu hình</Text>
                    </>
                  )}
                </Pressable>
              </View>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

/**
 * Huy hiệu AI Engine hiển thị trên Header (có thể bấm vào để mở Modal cấu hình).
 */
export function AIEngineBadge({
  onPress,
}: {
  onPress: () => void;
}): React.JSX.Element {
  const [config, setConfig] = useState<AIConfigData | null>(null);

  useEffect(() => {
    let isMounted = true;
    axios
      .get<AIConfigData>(API_ENDPOINTS.aiConfig, { timeout: 4000 })
      .then((res) => {
        if (isMounted) setConfig(res.data);
      })
      .catch(() => {});
    return () => {
      isMounted = false;
    };
  }, []);

  const isGemini = config?.active_engine === "gemini";

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        badgeStyles.badge,
        isGemini ? badgeStyles.geminiBadge : badgeStyles.localBadge,
        pressed && { opacity: 0.8 },
      ]}
    >
      <Ionicons
        name={isGemini ? "sparkles" : "hardware-chip-outline"}
        size={14}
        color={isGemini ? "#d8b4fe" : "#7dd3fc"}
      />
      <Text style={[badgeStyles.badgeText, isGemini ? badgeStyles.geminiText : badgeStyles.localText]}>
        {isGemini ? "✨ Google Gemini Pro (99%)" : "💻 Local AI (Offline)"}
      </Text>
      <Ionicons name="chevron-down" size={12} color="#94a3b8" style={{ marginLeft: 2 }} />
    </Pressable>
  );
}

const badgeStyles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
  },
  geminiBadge: {
    backgroundColor: "rgba(168, 85, 247, 0.15)",
    borderColor: "rgba(168, 85, 247, 0.4)",
  },
  localBadge: {
    backgroundColor: "rgba(56, 189, 248, 0.12)",
    borderColor: "rgba(56, 189, 248, 0.3)",
  },
  badgeText: {
    fontSize: 12,
    fontWeight: "700",
  },
  geminiText: {
    color: "#f3e8ff",
  },
  localText: {
    color: "#e0f2fe",
  },
});

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.75)",
    justifyContent: "center",
    alignItems: "center",
    padding: 16,
  },
  modalCard: {
    width: "100%",
    maxWidth: 520,
    backgroundColor: "#0f172a",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(168, 85, 247, 0.3)",
    overflow: "hidden",
    shadowColor: "#a855f7",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.25,
    shadowRadius: 25,
    elevation: 12,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#1e293b",
    backgroundColor: "#131d35",
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  iconBox: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: "rgba(168, 85, 247, 0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontSize: 16,
    fontWeight: "800",
    color: "#f8fafc",
  },
  subTitle: {
    fontSize: 12,
    color: "#94a3b8",
    marginTop: 1,
  },
  closeBtn: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: "#1e293b",
  },
  loadingBox: {
    padding: 40,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  loadingText: {
    color: "#94a3b8",
    fontSize: 13,
  },
  body: {
    padding: 20,
    gap: 16,
  },
  statusBox: {
    backgroundColor: "#1e293b",
    borderRadius: 12,
    padding: 12,
    gap: 8,
    borderWidth: 1,
    borderColor: "#334155",
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  statusLabel: {
    color: "#94a3b8",
    fontSize: 12,
    fontWeight: "600",
  },
  engineTag: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  engineTagGemini: {
    backgroundColor: "rgba(168, 85, 247, 0.25)",
  },
  engineTagLocal: {
    backgroundColor: "rgba(56, 189, 248, 0.2)",
  },
  engineTagText: {
    fontSize: 11,
    fontWeight: "700",
  },
  keyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: "rgba(255, 255, 255, 0.05)",
  },
  keyActiveText: {
    fontSize: 12,
    color: "#cbd5e1",
  },
  keyMissingText: {
    fontSize: 12,
    color: "#fbbf24",
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "800",
    color: "#64748b",
    letterSpacing: 0.5,
  },
  engineChoiceRow: {
    flexDirection: "row",
    gap: 12,
  },
  choiceCard: {
    flex: 1,
    backgroundColor: "#172033",
    borderRadius: 12,
    padding: 12,
    borderWidth: 1.5,
    borderColor: "#334155",
    gap: 6,
  },
  choiceCardActiveGemini: {
    borderColor: "#a855f7",
    backgroundColor: "rgba(168, 85, 247, 0.12)",
  },
  choiceCardActiveLocal: {
    borderColor: "#38bdf8",
    backgroundColor: "rgba(56, 189, 248, 0.1)",
  },
  choiceHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  radioDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: "#475569",
  },
  radioDotActiveGemini: {
    borderColor: "#a855f7",
    backgroundColor: "#a855f7",
  },
  radioDotActiveLocal: {
    borderColor: "#38bdf8",
    backgroundColor: "#38bdf8",
  },
  choiceTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#f1f5f9",
  },
  choiceDesc: {
    fontSize: 11,
    color: "#94a3b8",
    lineHeight: 15,
  },
  inputSection: {
    gap: 6,
  },
  inputHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  pasteBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: "rgba(168, 85, 247, 0.15)",
  },
  pasteBtnText: {
    fontSize: 11,
    color: "#c084fc",
    fontWeight: "600",
  },
  keyInput: {
    backgroundColor: "#090d16",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#334155",
    color: "#f8fafc",
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 13,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  inputHint: {
    fontSize: 11,
    color: "#64748b",
  },
  errBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(248, 113, 113, 0.12)",
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(248, 113, 113, 0.3)",
  },
  errBannerText: {
    fontSize: 12,
    color: "#fca5a5",
    flex: 1,
  },
  successBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(52, 211, 153, 0.12)",
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(52, 211, 153, 0.3)",
  },
  successBannerText: {
    fontSize: 12,
    color: "#6ee7b7",
    flex: 1,
  },
  btnRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 6,
  },
  cancelBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: "#1e293b",
  },
  cancelBtnText: {
    color: "#cbd5e1",
    fontSize: 13,
    fontWeight: "600",
  },
  saveBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: "#9333ea",
  },
  saveBtnText: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "700",
  },
});
